import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/adapters/codex.js";

class FakeCodexClient {
  notifications = new Set();
  serverRequests = new Set();
  responses = [];
  requests = [];
  started = false;

  onNotification(fn) { this.notifications.add(fn); }
  onServerRequest(fn) { this.serverRequests.add(fn); }
  async start() { this.started = true; }
  async close() {}
  respond(id, result) { this.responses.push({ id, result }); }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/list") return {
      data: [{ id: "thr_1", preview: "Fix tests", cwd: "/tmp/project", status: { type: "idle" } }],
      nextCursor: null,
    };
    if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "turn_1", status: "inProgress", items: [] } };
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
});
