import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/core/registry.js";

const fake = {
  id: "fake",
  async discover() {
    const now = "2026-08-08T00:00:00.000Z";
    return [{ id: "fake:1", provider: "fake", source: "fake", name: "fake one", status: "idle",
      capabilities: { prompt: true, sendKeys: false, approve: false, reject: false, interrupt: false, focus: false, read: false },
      discoveredAt: now, updatedAt: now }];
  },
  async prompt(agent, text) { return { ok: true, agentId: agent.id, action: "prompt", data: text }; }
};

test("discovers and invokes capability-backed action", async () => {
  const registry = new AgentRegistry([fake]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();
  assert.equal(registry.list().length, 1);
  const result = await registry.action("fake:1", "prompt", { text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.data, "hello");
  assert.deepEqual(events.at(-1), {
    type: "agent.action",
    agentId: "fake:1",
    action: "prompt",
    ok: true,
    code: undefined,
    snapshotRevision: 1,
    at: events.at(-1).at,
    sequence: 2,
  });
});

test("rejects unsupported actions", async () => {
  const registry = new AgentRegistry([fake]);
  await registry.refresh();
  const result = await registry.action("fake:1", "approve");
  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_not_available");
});

test("preserves unchanged agents and emits semantic revisions", async () => {
  let name = "stable";
  let metadataTick = 0;
  let present = true;
  const adapter = {
    id: "changing-clock",
    async discover() {
      const now = new Date().toISOString();
      return present ? [{
        id: "clock:1",
        provider: "clock",
        source: "changing-clock",
        name,
        status: "idle",
        capabilities: { prompt: false },
        metadata: { volatileProviderTimestamp: metadataTick++ },
        discoveredAt: now,
        updatedAt: now,
      }] : [];
    },
  };
  const registry = new AgentRegistry([adapter]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));

  await registry.refresh();
  const first = registry.get("clock:1");
  assert.equal(registry.revision, 1);
  assert.equal(events[0].type, "agent.discovered");
  assert.equal(events[0].agent.id, "clock:1");
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].snapshotRevision, 1);

  await registry.refresh();
  assert.equal(registry.revision, 1);
  assert.equal(registry.get("clock:1"), first);
  assert.equal(events.length, 1);

  name = "changed";
  await registry.refresh();
  assert.equal(registry.revision, 2);
  assert.equal(events.at(-1).type, "agent.updated");
  assert.equal(events.at(-1).agent.id, "clock:1");
  assert.equal(events.at(-1).sequence, 2);
  assert.equal(events.at(-1).snapshotRevision, 2);
  assert.equal(registry.get("clock:1").discoveredAt, first.discoveredAt);

  present = false;
  await registry.refresh();
  assert.equal(registry.revision, 3);
  assert.deepEqual(events.at(-1), {
    type: "agent.removed",
    agentId: "clock:1",
    at: events.at(-1).at,
    snapshotRevision: 3,
    sequence: 3,
  });
});

test("uses agent id as the deterministic list order tie-breaker", async () => {
  const adapter = {
    id: "same-name",
    async discover() {
      return ["z", "a"].map((id) => ({
        id: `same:${id}`,
        provider: "test",
        source: "same-name",
        name: "Same name",
        status: "idle",
        capabilities: {},
      }));
    },
  };
  const registry = new AgentRegistry([adapter]);
  await registry.refresh();
  assert.deepEqual(registry.list().map((agent) => agent.id), ["same:a", "same:z"]);
});

test("preserves last-known agents when adapter discovery fails", async () => {
  let failing = false;
  const adapter = {
    id: "sometimes",
    async discover() {
      if (failing) throw new Error("temporarily unavailable");
      return [{ id: "sometimes:1", provider: "test", source: "sometimes", name: "agent", status: "idle", capabilities: {} }];
    },
  };
  const registry = new AgentRegistry([adapter]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();
  const first = registry.get("sometimes:1");
  const eventCount = events.length;
  const originalError = console.error;

  failing = true;
  console.error = () => {};
  try { await registry.refresh(); }
  finally { console.error = originalError; }
  assert.equal(registry.get("sometimes:1"), first);
  assert.equal(registry.revision, 1);
  assert.equal(events.length, eventCount);
});

test("returns stable action error codes", async () => {
  const throwing = {
    id: "throwing",
    async discover() {
      return [{
        id: "throwing:1",
        provider: "test",
        source: "throwing",
        name: "throwing",
        status: "idle",
        capabilities: { prompt: true },
      }];
    },
    async prompt() { throw new Error("backend unavailable"); },
  };
  const registry = new AgentRegistry([throwing]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();

  assert.equal((await registry.action("missing", "prompt", { text: "x" })).code, "agent_not_found");
  assert.equal((await registry.action("throwing:1", "missing")).code, "unknown_action");
  const failed = await registry.action("throwing:1", "prompt", { text: "x" });
  assert.equal(failed.code, "action_failed");
  assert.equal(failed.message, "backend unavailable");
  assert.equal(events.at(-1).type, "agent.action");
  assert.equal(events.at(-1).action, "prompt");
  assert.equal(events.at(-1).ok, false);
  assert.equal(events.at(-1).code, "action_failed");
  assert.equal(events.at(-1).snapshotRevision, 1);
  assert.equal(events.at(-1).sequence, 2);
});
