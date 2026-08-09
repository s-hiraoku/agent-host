import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/adapters/codex.js";

class FakeCodexClient {
  notifications = new Set();
  serverRequests = new Set();
  responses = [];
  responseErrors = [];
  requests = [];
  started = false;
  startCalls = 0;
  closeCalls = 0;
  failSteer = false;
  threadListResult;

  onNotification(fn) { this.notifications.add(fn); }
  onServerRequest(fn) { this.serverRequests.add(fn); }
  async start() { this.started = true; this.startCalls += 1; }
  async close() { this.started = false; this.closeCalls += 1; }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responseErrors.push({ id, code, message }); }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/list") return this.threadListResult ?? {
      data: [{ id: "thr_1", preview: "Fix tests", cwd: "/tmp/project", status: { type: "idle" } }],
      nextCursor: null,
    };
    if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "turn_1", status: "inProgress", items: [] } };
    if (method === "turn/steer") {
      if (this.failSteer) { this.failSteer = false; throw new Error("stale turn"); }
      return { turnId: params.expectedTurnId };
    }
    if (method === "turn/interrupt") return {};
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    return {};
  }

  emitServerRequest(message) { for (const fn of this.serverRequests) fn(message); }
  emitNotification(message) { for (const fn of this.notifications) fn(message); }
}

test("Codex adapter discovers threads and sends prompts", async () => {
  const client = new FakeCodexClient();
  const adapter = new CodexAdapter({ client });
  const [agent] = await adapter.discover();
  assert.equal(agent.id, "codex:thr_1");
  assert.equal(agent.status, "idle");
  assert.equal(agent.capabilities.prompt, true);

  const result = await adapter.prompt(agent, "run tests");
  assert.equal(result.ok, true);
  assert.equal(client.requests.some((entry) => entry.method === "thread/resume"), true);
  assert.equal(client.requests.some((entry) => entry.method === "turn/start"), true);
});

test("Codex adapter exposes and resolves semantic approvals", async () => {
  const client = new FakeCodexClient();
  const adapter = new CodexAdapter({ client });
  await adapter.discover();

  client.emitServerRequest({
    id: 61,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", command: "npm test", reason: "Run tests" },
  });

  const [blocked] = await adapter.discover();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.capabilities.approve, true);
  assert.equal(blocked.metadata.pendingApprovals[0].approvalId, "61");

  const result = await adapter.approve(blocked, { approvalId: "61" });
  assert.equal(result.ok, true);
  assert.deepEqual(client.responses, [{ id: 61, result: { decision: "accept" } }]);

  const [cleared] = await adapter.discover();
  assert.equal(cleared.capabilities.approve, false);

  client.emitServerRequest({
    id: 62,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_2" },
  });
  const [pendingReject] = await adapter.discover();
  const rejected = await adapter.reject(pendingReject, { approvalId: "62" });
  assert.equal(rejected.ok, true);
  assert.deepEqual(client.responses.at(-1), { id: 62, result: { decision: "decline" } });

  for (const id of [63, 64]) client.emitServerRequest({
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: `item_${id}` },
  });
  const [ambiguous] = await adapter.discover();
  assert.equal((await adapter.approve(ambiguous)).message, "multiple approvals are pending; pass approvalId");
  assert.equal((await adapter.approve(ambiguous, { approvalId: "missing" })).message, "no matching approval is pending");
  await adapter.close();
});

test("Codex adapter steers active turns and recovers from stale turn ids", async () => {
  const client = new FakeCodexClient();
  const adapter = new CodexAdapter({ client });
  const [agent] = await adapter.discover();
  client.emitNotification({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_active" } } });

  assert.equal((await adapter.prompt(agent, "more context")).ok, true);
  assert.deepEqual(client.requests.find((entry) => entry.method === "turn/steer")?.params, {
    threadId: "thr_1",
    expectedTurnId: "turn_active",
    input: [{ type: "text", text: "more context" }],
  });

  client.failSteer = true;
  assert.equal((await adapter.prompt(agent, "retry safely")).ok, true);
  assert.equal(client.requests.at(-1).method, "turn/start");

  await adapter.interrupt(agent);
  const beforePrompt = client.requests.length;
  await adapter.prompt(agent, "new turn");
  assert.equal(client.requests.slice(beforePrompt).some((entry) => entry.method === "turn/steer"), false);
  assert.equal(client.requests.at(-1).method, "turn/start");
});

test("Codex adapter clears terminal state and restarts after close", async () => {
  const client = new FakeCodexClient();
  const adapter = new CodexAdapter({ client });
  await adapter.discover();
  client.emitNotification({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_active" } } });
  client.emitServerRequest({
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_active", itemId: "item_71" },
  });
  client.emitNotification({
    method: "turn/completed",
    params: { threadId: "thr_1", turn: { id: "turn_active", status: "failed" } },
  });

  const [agent] = await adapter.discover();
  assert.equal(agent.status, "error");
  assert.equal(agent.metadata.activeTurnId, undefined);
  assert.deepEqual(agent.metadata.pendingApprovals, []);

  await adapter.close();
  await adapter.discover();
  assert.equal(client.startCalls, 2);
});

test("Codex adapter bounds pagination and rejects unsupported server requests", async () => {
  const client = new FakeCodexClient();
  client.threadListResult = { data: [], nextCursor: "unchanged" };
  const adapter = new CodexAdapter({ client });
  assert.deepEqual(await adapter.discover(), []);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/list").length, 20);

  client.emitServerRequest({ id: 81, method: "mcpServer/elicitation/request", params: { threadId: "thr_1" } });
  assert.deepEqual(client.responseErrors, [{
    id: 81,
    code: -32601,
    message: "Unsupported server request: mcpServer/elicitation/request",
  }]);
});

test("Codex adapter cancels expired approvals", { timeout: 1000 }, async () => {
  const client = new FakeCodexClient();
  const adapter = new CodexAdapter({ client, approvalTimeoutMs: 10 });
  await adapter.discover();
  client.emitServerRequest({
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_91" },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(client.responses, [{ id: 91, result: { decision: "cancel" } }]);
  assert.equal((await adapter.discover())[0].capabilities.approve, false);
});
