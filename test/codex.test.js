import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/adapters/codex.js";
import { AgentRegistry } from "../src/core/registry.js";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

class FakeCodexClient {
  notifications = new Set();
  serverRequests = new Set();
  stateHandlers = new Set();
  responses = [];
  responseErrors = [];
  requests = [];
  started = false;
  startCalls = 0;
  closeCalls = 0;
  failSteer = false;
  threadListResult;
  threadListHandler;
  loadedThreads = [];
  resumeFailures = new Set();
  generation = 1;
  defaultCanAcceptDirectInput = true;
  disconnectOnMethod;

  onNotification(fn) { this.notifications.add(fn); }
  onServerRequest(fn) { this.serverRequests.add(fn); }
  onStateChange(fn) { this.stateHandlers.add(fn); }
  async start() { this.started = true; this.startCalls += 1; }
  async close() { this.started = false; this.closeCalls += 1; }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responseErrors.push({ id, code, message }); }

  async request(method, params, options) {
    this.requests.push({ method, params, options });
    if (this.disconnectOnMethod === method) {
      this.disconnectOnMethod = undefined;
      this.emitState({ state: "disconnected", generation: this.generation, error: new Error("socket lost") });
      throw new Error("socket lost");
    }
    if (method === "thread/list") return this.threadListHandler?.(params) ?? this.threadListResult ?? {
      data: [{ id: "thr_1", preview: "Fix tests", cwd: "/tmp/project", status: { type: "idle" } }],
      nextCursor: null,
    };
    if (method === "thread/loaded/list") return { data: this.loadedThreads };
    if (method === "thread/resume") {
      if (this.resumeFailures.has(params.threadId)) throw new Error("resume failed");
      const loaded = this.loadedThreads.find((thread) => (
        typeof thread === "string" ? thread : thread.id ?? thread.threadId
      ) === params.threadId);
      const summary = typeof loaded === "object" ? loaded : {};
      return { thread: {
        ...summary,
        id: params.threadId,
        status: summary.status ?? { type: "idle" },
        ...(summary.canAcceptDirectInput === undefined && this.defaultCanAcceptDirectInput !== undefined
          ? { canAcceptDirectInput: this.defaultCanAcceptDirectInput }
          : {}),
      } };
    }
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
  emitState(event) { for (const fn of this.stateHandlers) fn(event); }
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
  assert.equal(blocked.pendingApprovals[0].approvalId, "61");

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
  assert.equal(agent.activeTurnId, undefined);
  assert.deepEqual(agent.pendingApprovals, []);

  await adapter.close();
  await adapter.discover();
  assert.equal(client.startCalls, 2);
});

test("Codex adapter bounds pagination and rejects unsupported server requests", async () => {
  const client = new FakeCodexClient();
  client.threadListResult = { data: [], nextCursor: "unchanged" };
  const adapter = new CodexAdapter({ client });
  assert.deepEqual(await adapter.discover(), []);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/list").length, 1);
  assert.deepEqual(await adapter.discoverHistory(), []);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/list").length, 11);
  client.threadListResult = {
    data: Array.from({ length: 101 }, (_, index) => ({ id: `excess-${index}`, status: { type: "notLoaded" } })),
    nextCursor: null,
  };
  assert.equal((await adapter.discover()).length, 100);

  client.emitServerRequest({ id: 81, method: "mcpServer/elicitation/request", params: { threadId: "thr_1" } });
  assert.deepEqual(client.responseErrors, [{
    id: 81,
    code: -32601,
    message: "Unsupported server request: mcpServer/elicitation/request",
  }]);
});

test("Codex adapter preserves activity time and separates recent history", async () => {
  const client = new FakeCodexClient();
  client.threadListResult = {
    data: [
      { id: "recent", preview: "Recent", cwd: "/tmp", status: { type: "notLoaded" }, updatedAt: 1_699_999_000 },
      { id: "old", preview: "Old", cwd: "/tmp", status: { type: "notLoaded" }, updatedAt: 1_600_000_000 },
    ],
    nextCursor: null,
  };
  const adapter = new CodexAdapter({ client, now: () => 1_700_000_000_000, recentMs: 10_000_000 });
  const agents = await adapter.discover();
  assert.equal(agents[0].status, "unknown");
  assert.equal(agents[0].lastActivityAt, "2023-11-14T21:56:40.000Z");
  assert.equal(agents[0].discovery.visibility, "recent");
  assert.equal(agents[1].discovery.visibility, "historical");
});

test("Codex history remains pageable beyond the one-page working set", async () => {
  const client = new FakeCodexClient();
  client.threadListHandler = ({ cursor }) => {
    const offset = Number(cursor ?? 0);
    return {
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `thread-${offset + index}`,
        preview: `Thread ${offset + index}`,
        cwd: "/tmp",
        status: { type: "notLoaded" },
        updatedAt: 1_600_000_000,
      })),
      nextCursor: offset + 100 < 1_000 ? String(offset + 100) : null,
    };
  };
  const adapter = new CodexAdapter({ client });
  assert.equal((await adapter.discover()).length, 100);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/list").length, 1);
  client.requests = [];
  assert.equal((await adapter.discoverHistory()).length, 1_000);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/list").length, 10);
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

test("Codex control mode subscribes only loaded threads and gates persisted-only sessions", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [
    "loaded",
    { id: "child", name: "Parent-owned child", status: { type: "idle" }, canAcceptDirectInput: false },
    { id: "failed", status: { type: "idle" } },
  ];
  client.resumeFailures.add("failed");
  client.threadListResult = {
    data: [
      { id: "loaded", name: "External session", cwd: "/tmp/live", status: { type: "idle" } },
      { id: "persisted", name: "Closed session", cwd: "/tmp/closed", status: { type: "notLoaded" } },
      { id: "child", name: "Parent-owned child", status: { type: "idle" } },
      { id: "failed", name: "Failed subscribe", status: { type: "idle" } },
    ],
    nextCursor: null,
  };
  const adapter = new CodexAdapter({ mode: "control", client });
  const agents = await adapter.discover();
  const loaded = agents.find((agent) => agent.sessionId === "loaded");
  const persisted = agents.find((agent) => agent.sessionId === "persisted");
  const child = agents.find((agent) => agent.sessionId === "child");
  const failed = agents.find((agent) => agent.sessionId === "failed");

  assert.equal(loaded.capabilities.prompt, true);
  assert.equal(loaded.capabilities.read, true);
  assert.equal(loaded.discovery.provenance, "shared-control-socket");
  assert.deepEqual(persisted.capabilities, {
    prompt: false, sendKeys: false, approve: false, reject: false, interrupt: false, focus: false, read: false,
  });
  assert.equal(child.capabilities.prompt, false);
  assert.equal(child.capabilities.read, true);
  assert.equal(failed.capabilities.read, false);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/resume").length, 3);

  assert.equal((await adapter.prompt(persisted, "should fail")).ok, false);
  await adapter.discover();
  assert.equal(client.requests.filter((entry) => entry.method === "thread/resume").length, 4);
  await adapter.close();
});

test("Codex control mode invalidates approvals and capabilities across reconnects", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "active" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  let changes = 0;
  adapter.onChange(() => { changes += 1; });
  await adapter.discover();

  client.emitServerRequest({
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    connectionGeneration: 1,
  });
  let [agent] = await adapter.discover();
  assert.equal(agent.pendingApprovals[0].approvalId, "1:thr_1:101");

  client.emitState({ state: "disconnected", generation: 1, error: new Error("lost") });
  const stale = adapter.markStale(agent);
  assert.equal(stale.status, "unknown");
  assert.equal(Object.values(stale.capabilities).some(Boolean), false);
  assert.deepEqual(stale.pendingApprovals, []);

  client.generation = 2;
  client.emitState({ state: "connected", generation: 2 });
  await adapter.discover();
  client.emitServerRequest({
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_2", itemId: "item_2" },
    connectionGeneration: 1,
  });
  client.emitServerRequest({
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_2", itemId: "item_2" },
    connectionGeneration: 2,
  });
  [agent] = await adapter.discover();
  assert.deepEqual(agent.pendingApprovals.map((approval) => approval.approvalId), ["2:thr_1:101"]);
  assert.equal((await adapter.approve(agent, { approvalId: "1:thr_1:101" })).ok, false);
  assert.equal((await adapter.approve(agent, { approvalId: "2:thr_1:101" })).ok, true);
  assert.ok(changes >= 3);
  await adapter.close();
});

test("Codex control mode does not resolve shared requests it does not own", { timeout: 1000 }, async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "idle" } }];
  const adapter = new CodexAdapter({ mode: "control", client, approvalTimeoutMs: 10 });
  await adapter.discover();
  client.emitServerRequest({
    id: 201,
    method: "mcpServer/elicitation/request",
    params: { threadId: "thr_1" },
    connectionGeneration: 1,
  });
  client.emitServerRequest({
    id: 202,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    connectionGeneration: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(client.responses, []);
  assert.deepEqual(client.responseErrors, []);
  assert.equal((await adapter.discover())[0].capabilities.approve, false);
  await adapter.close();
});

test("Codex control mode requires affirmative direct-input authority", async () => {
  const client = new FakeCodexClient();
  client.defaultCanAcceptDirectInput = undefined;
  client.loadedThreads = ["thr_1"];
  const adapter = new CodexAdapter({ mode: "control", client });
  const [agent] = await adapter.discover();
  assert.equal(agent.capabilities.prompt, false);
  assert.equal(agent.capabilities.read, true);
  assert.equal((await adapter.prompt(agent, "unsafe")).ok, false);
  assert.equal(client.requests.some((entry) => entry.method === "turn/start"), false);
  await adapter.close();
});

test("Codex control mode does not continue a mutation after its connection generation drops", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "active" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  const [agent] = await adapter.discover();
  client.emitNotification({
    method: "turn/started",
    params: { threadId: "thr_1", turn: { id: "turn_live" } },
    connectionGeneration: 1,
  });
  client.disconnectOnMethod = "turn/steer";
  const result = await adapter.prompt(agent, "must not restart");
  assert.equal(result.ok, false);
  assert.equal(client.requests.filter((entry) => entry.method === "turn/start").length, 0);
  assert.equal(client.startCalls, 1);
  await adapter.close();
});

test("Codex control mode never retries an uncertain steer as a new turn", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "active" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  const [agent] = await adapter.discover();
  client.emitNotification({
    method: "turn/started",
    params: { threadId: "thr_1", turn: { id: "turn_live" } },
    connectionGeneration: 1,
  });
  client.failSteer = true;
  const result = await adapter.prompt(agent, "do not duplicate");
  assert.equal(result.ok, false);
  assert.equal(client.requests.filter((entry) => entry.method === "turn/steer").length, 1);
  assert.equal(client.requests.filter((entry) => entry.method === "turn/start").length, 0);
  await adapter.close();
});

test("Codex control mode clears live state when a thread unloads", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "active" }, canAcceptDirectInput: true }];
  client.threadListResult = {
    data: [{ id: "thr_1", name: "Persisted", status: { type: "notLoaded" } }],
    nextCursor: null,
  };
  const adapter = new CodexAdapter({ mode: "control", client });
  let [agent] = await adapter.discover();
  client.emitNotification({
    method: "turn/started",
    params: { threadId: "thr_1", turn: { id: "turn_live" } },
    connectionGeneration: 1,
  });
  [agent] = await adapter.discover();
  assert.equal(agent.status, "working");

  client.loadedThreads = [];
  [agent] = await adapter.discover();
  assert.equal(agent.status, "unknown");
  assert.equal(agent.activeTurnId, undefined);
  assert.equal(Object.values(agent.capabilities).some(Boolean), false);
  await adapter.close();
});

test("Codex control mode converges when another subscriber resolves an approval first", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "idle" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  await adapter.discover();
  client.emitServerRequest({
    id: 401,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    connectionGeneration: 1,
  });
  client.emitNotification({
    method: "serverRequest/resolved",
    params: { requestId: 401 },
    connectionGeneration: 1,
  });
  const [agent] = await adapter.discover();
  assert.equal(agent.capabilities.approve, false);
  assert.equal((await adapter.approve(agent, { approvalId: "1:thr_1:401" })).ok, false);
  assert.deepEqual(client.responses, []);
  await adapter.close();
});

test("Codex live notifications refresh the registry without polling history", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "idle" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  const registry = new AgentRegistry([adapter]);
  await registry.refresh();

  client.emitNotification({
    method: "turn/started",
    params: { threadId: "thr_1", turn: { id: "turn_live" } },
    connectionGeneration: 1,
  });
  await waitFor(() => registry.get("codex:thr_1")?.status === "working");
  assert.equal(registry.get("codex:thr_1").capabilities.interrupt, true);

  client.emitServerRequest({
    id: 301,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_live", itemId: "item_live" },
    connectionGeneration: 1,
  });
  await waitFor(() => registry.get("codex:thr_1")?.status === "blocked");
  assert.equal(registry.get("codex:thr_1").pendingApprovals[0].approvalId, "1:thr_1:301");

  client.emitNotification({
    method: "turn/completed",
    params: { threadId: "thr_1", turn: { id: "turn_live", status: "completed" } },
    connectionGeneration: 1,
  });
  await waitFor(() => registry.get("codex:thr_1")?.status === "idle");
  assert.deepEqual(registry.get("codex:thr_1").pendingApprovals, []);
  await registry.close();
});

test("Codex ignores notifications that do not change canonical state", async () => {
  const client = new FakeCodexClient();
  client.loadedThreads = [{ id: "thr_1", status: { type: "idle" }, canAcceptDirectInput: true }];
  const adapter = new CodexAdapter({ mode: "control", client });
  let changes = 0;
  adapter.onChange(() => { changes += 1; });
  await adapter.discover();

  client.emitNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thr_1", delta: "streamed output" },
    connectionGeneration: 1,
  });
  client.emitNotification({
    method: "thread/status/changed",
    params: { threadId: "thr_1", status: { type: "idle" } },
    connectionGeneration: 1,
  });

  assert.equal(changes, 0);
  await adapter.close();
});
