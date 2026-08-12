import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/core/registry.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("rejects invalid discovery timing options", () => {
  for (const adapterTimeoutMs of [0, -1, NaN, 1.5]) {
    assert.throws(
      () => new AgentRegistry([], { adapterTimeoutMs }),
      /adapterTimeoutMs must be a positive integer/,
    );
  }
  for (const historyTtlMs of [0, -1, NaN, 1.5]) {
    assert.throws(
      () => new AgentRegistry([], { historyTtlMs }),
      /historyTtlMs must be a positive integer/,
    );
  }
});

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
    sequence: 3,
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
  assert.equal(events.length, 2);

  name = "changed";
  await registry.refresh();
  assert.equal(registry.revision, 2);
  assert.equal(events.at(-1).type, "agent.updated");
  assert.equal(events.at(-1).agent.id, "clock:1");
  assert.equal(events.at(-1).sequence, 3);
  assert.equal(events.at(-1).snapshotRevision, 2);
  assert.equal(registry.get("clock:1").discoveredAt, first.discoveredAt);

  present = false;
  await registry.refresh();
  assert.equal(registry.revision, 3);
  const removed = events.findLast((event) => event.type === "agent.removed");
  assert.deepEqual(removed, {
    type: "agent.removed",
    agentId: "clock:1",
    at: removed.at,
    snapshotRevision: 3,
    sequence: 4,
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
  const mutableCopy = registry.list();
  mutableCopy.pop();
  assert.deepEqual(registry.list().map((agent) => agent.id), ["same:a", "same:z"]);
});

test("preserves last-known agents when adapter discovery fails", async () => {
  let failing = false;
  let staleCalls = 0;
  const adapter = {
    id: "sometimes",
    async discover() {
      if (failing) throw new Error("temporarily unavailable");
      return [{ id: "sometimes:1", provider: "test", source: "sometimes", name: "agent", status: "idle", capabilities: {} }];
    },
    markStale(agent) {
      staleCalls += 1;
      return { ...agent, status: "unknown", capabilities: {} };
    },
  };
  const registry = new AgentRegistry([adapter]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();
  const first = registry.get("sometimes:1");
  const agentEventCount = events.filter((event) => event.type.startsWith("agent.")).length;
  const originalError = console.error;

  failing = true;
  console.error = () => {};
  try { await registry.refresh(); }
  finally { console.error = originalError; }
  assert.equal(registry.get("sometimes:1"), first);
  assert.equal(staleCalls, 0);
  assert.equal(registry.revision, 1);
  assert.equal(events.filter((event) => event.type.startsWith("agent.")).length, agentEventCount);
  assert.equal(events.at(-1).type, "adapter.health");
  assert.equal(events.at(-1).adapter.status, "error");
});

test("marks adapter records stale immediately when its live transport disconnects", async () => {
  let changeHandler;
  let disconnected = false;
  let unsubscribed = false;
  const adapter = {
    id: "live",
    onChange(handler) {
      changeHandler = handler;
      return () => { unsubscribed = true; };
    },
    async discover() {
      if (disconnected) throw new Error("control socket lost");
      return [{
        id: "live:1", provider: "codex", source: "live", name: "live", status: "working",
        capabilities: { prompt: true, interrupt: true },
        pendingApprovals: [{ approvalId: "1" }],
        discovery: { kind: "native", confidence: "high", visibility: "active" },
      }];
    },
    markStale(agent) {
      return {
        ...agent,
        status: "unknown",
        capabilities: { prompt: false, interrupt: false },
        pendingApprovals: [],
        discovery: { ...agent.discovery, confidence: "low", visibility: "recent" },
      };
    },
  };
  const registry = new AgentRegistry([adapter]);
  await registry.refresh();
  disconnected = true;
  changeHandler({ type: "disconnected", error: new Error("control socket lost") });

  const stale = registry.get("live:1");
  assert.equal(stale.status, "unknown");
  assert.equal(stale.capabilities.prompt, false);
  assert.deepEqual(stale.pendingApprovals, []);
  assert.equal(stale.discovery.confidence, "low");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get("live:1"), stale);
  await registry.close();
  assert.equal(unsubscribed, true);
});

test("rejects discovery results from an obsolete adapter transport", async () => {
  let current = true;
  let name = "initial";
  const adapter = {
    id: "generation",
    async discover() {
      return [{
        id: "generation:1", provider: "test", source: "generation", name, status: "working",
        capabilities: { prompt: true },
      }];
    },
    isDiscoveryCurrent() { return current; },
    markStale(agent) {
      return { ...agent, status: "unknown", capabilities: { prompt: false } };
    },
  };
  const registry = new AgentRegistry([adapter]);
  await registry.refresh();
  name = "obsolete";
  current = false;
  await registry.refresh();
  assert.equal(registry.get("generation:1").name, "initial");
  assert.equal(registry.get("generation:1").status, "unknown");
  assert.equal(registry.get("generation:1").capabilities.prompt, false);
  assert.equal(registry.adapterHealth()[0].status, "error");
  await registry.close();
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
  assert.equal(events.at(-1).sequence, 3);
});

test("keeps history separate and reconciles only exact process identities", async () => {
  let historyCalls = 0;
  let richName = "Rich";
  let looseName = "Loose";
  const rich = {
    id: "rich",
    async discover() {
      return [{
        id: "rich:42", provider: "codex", source: "rich", name: richName, status: "working", pid: 42, cwd: "/work",
        capabilities: { prompt: true }, discovery: { kind: "native", confidence: "high", visibility: "active" },
      }];
    },
    async discoverHistory() {
      historyCalls += 1;
      return [
        {
          id: "rich:old", provider: "codex", source: "rich", name: "Old", status: "unknown", cwd: "/old",
          lastActivityAt: "2020-01-01T00:00:00.000Z", capabilities: {},
          discovery: { kind: "native", confidence: "high", visibility: "historical" },
        },
        {
          id: "rich:42", provider: "codex", source: "rich", name: "Stale Rich", status: "unknown", pid: 42,
          capabilities: {}, discovery: { kind: "native", confidence: "high", visibility: "historical" },
        },
      ];
    },
  };
  const processes = {
    id: "process",
    async discover() {
      return [
        { id: "process:42", provider: "codex", source: "process", name: "Duplicate", status: "unknown", pid: 42, cwd: "/work", capabilities: {}, discovery: { kind: "process", confidence: "high", visibility: "active" } },
        { id: "process:43", provider: "codex", source: "process", name: "Same cwd", status: "unknown", pid: 43, cwd: "/work", capabilities: {}, discovery: { kind: "process", confidence: "high", visibility: "active" } },
        { id: "process:44", provider: "codex", source: "process", name: looseName, status: "unknown", pid: 44, capabilities: {}, discovery: { kind: "process", confidence: "low", visibility: "raw" } },
      ];
    },
  };
  const registry = new AgentRegistry([rich, processes]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();

  assert.deepEqual(registry.list().map((agent) => agent.id), ["rich:42", "process:43"]);
  assert.equal(registry.get("process:42").discovery.duplicateOf, "rich:42");
  const revision = registry.revision;
  const eventCount = events.length;
  const historical = await registry.listView("historical");
  assert.deepEqual(historical.agents.map((agent) => agent.id), ["rich:old"]);
  await registry.listView("historical");
  assert.equal(historyCalls, 1);
  assert.equal(registry.revision, revision);
  assert.equal(events.length, eventCount);

  const raw = await registry.listView("raw");
  assert.deepEqual(new Set(raw.agents.map((agent) => agent.id)), new Set(["rich:old", "rich:42", "process:42", "process:43", "process:44"]));
  assert.equal(raw.agents.find((agent) => agent.id === "process:42").discovery.duplicateOf, "rich:42");

  looseName = "Loose changed";
  await registry.refresh();
  const rawAfterLooseChange = await registry.listView("raw");
  assert.notEqual(rawAfterLooseChange.cursorRevision, raw.cursorRevision);

  const historicalCursorRevision = historical.cursorRevision;
  richName = "Rich changed";
  await registry.refresh();
  const historicalAfterLiveChange = await registry.listView("historical");
  assert.notEqual(historicalAfterLiveChange.cursorRevision, historicalCursorRevision);
  assert.deepEqual(historicalAfterLiveChange.agents.map((agent) => agent.id), ["rich:old"]);
});

test("historical cursors track live historical records without cached history", async () => {
  let name = "Historical";
  const registry = new AgentRegistry([{
    id: "live-history",
    async discover() {
      return [{
        id: "live:historical", provider: "fixture", source: "live-history", name, status: "unknown",
        capabilities: {}, discovery: { kind: "native", confidence: "high", visibility: "historical" },
      }];
    },
  }]);
  await registry.refresh();
  const first = await registry.listView("historical");
  assert.deepEqual(first.agents.map((agent) => agent.id), ["live:historical"]);
  name = "Historical changed";
  await registry.refresh();
  const second = await registry.listView("historical");
  assert.notEqual(second.cursorRevision, first.cursorRevision);
});

test("retries history discovery immediately after a transient failure", async () => {
  let calls = 0;
  const registry = new AgentRegistry([{
    id: "history-retry",
    async discover() { return []; },
    async discoverHistory() {
      calls += 1;
      if (calls === 1) throw new Error("temporary");
      return [{
        id: "history:recovered", provider: "fixture", source: "history-retry", name: "Recovered", status: "unknown",
        capabilities: {}, discovery: { kind: "native", confidence: "high", visibility: "historical" },
      }];
    },
  }]);
  await registry.refresh();
  assert.deepEqual((await registry.listView("historical")).agents, []);
  assert.deepEqual((await registry.listView("historical")).agents.map((agent) => agent.id), ["history:recovered"]);
  assert.equal(calls, 2);
});

test("coalesces refreshes and discovers adapters concurrently", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const calls = [];
  const adapter = (id, gate) => ({
    id,
    async discover() {
      calls.push(id);
      await gate.promise;
      return [{ id: `${id}:1`, provider: id, source: id, name: id, status: "idle", capabilities: {} }];
    },
  });
  const registry = new AgentRegistry([
    adapter("first", firstGate),
    adapter("second", secondGate),
  ], { adapterTimeoutMs: 1_000 });
  const healthEvents = [];
  registry.events.subscribe((event) => {
    if (event.type === "adapter.health") healthEvents.push(event);
  });

  const firstRefresh = registry.refresh();
  const coalescedRefresh = registry.refresh();
  assert.equal(firstRefresh, coalescedRefresh);
  await nextTurn();
  assert.deepEqual(calls.sort(), ["first", "second"]);

  firstGate.resolve();
  secondGate.resolve();
  await firstRefresh;
  assert.equal(registry.initialLoading, false);
  assert.equal(registry.refreshing, false);
  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.adapterHealth().map((health) => health.status), ["healthy", "healthy"]);
  assert.equal(healthEvents.length, 2);

  await registry.refresh();
  assert.equal(healthEvents.length, 2);
});

test("publishes a healthy adapter before a slow adapter completes", async () => {
  const slowGate = deferred();
  const slow = {
    id: "slow",
    async discover() {
      await slowGate.promise;
      return [];
    },
  };
  const fast = {
    id: "fast",
    async discover() {
      return [{ id: "fast:1", provider: "test", source: "fast", name: "fast", status: "idle", capabilities: {} }];
    },
  };
  const registry = new AgentRegistry([slow, fast], { adapterTimeoutMs: 1_000 });
  let completed = false;
  const refresh = registry.refresh().then(() => { completed = true; });

  await nextTurn();
  assert.equal(completed, false);
  assert.deepEqual(registry.list().map((agent) => agent.id), ["fast:1"]);
  assert.equal(registry.adapterHealth().find((health) => health.id === "fast").status, "healthy");
  assert.equal(registry.adapterHealth().find((health) => health.id === "slow").status, "loading");

  slowGate.resolve();
  await refresh;
});

test("times out a hanging adapter without duplicating discovery or blocking healthy results", async () => {
  let hangingCalls = 0;
  const hanging = {
    id: "hanging",
    async discover() {
      hangingCalls += 1;
      return new Promise(() => {});
    },
  };
  const healthy = {
    id: "healthy",
    async discover() {
      return [{ id: "healthy:1", provider: "test", source: "healthy", name: "healthy", status: "idle", capabilities: {} }];
    },
  };
  const registry = new AgentRegistry([hanging, healthy], { adapterTimeoutMs: 10 });
  const healthEvents = [];
  registry.events.subscribe((event) => {
    if (event.type === "adapter.health") healthEvents.push(event);
  });

  await registry.refresh();
  assert.deepEqual(registry.list().map((agent) => agent.id), ["healthy:1"]);
  assert.equal(registry.adapterHealth().find((health) => health.id === "hanging").status, "timeout");
  assert.equal(registry.readiness().ready, true);
  assert.equal(registry.readiness().degraded, true);

  await registry.refresh();
  assert.equal(hangingCalls, 1);
  assert.equal(healthEvents.filter((event) => event.adapter.id === "hanging").length, 1);
  await registry.close();
});

test("ignores a late timed-out result and retries after its flight settles", async () => {
  const firstGate = deferred();
  let calls = 0;
  const adapter = {
    id: "late",
    async discover() {
      calls += 1;
      if (calls === 1) return firstGate.promise;
      return [{ id: "late:recovered", provider: "test", source: "late", name: "recovered", status: "idle", capabilities: {} }];
    },
  };
  const registry = new AgentRegistry([adapter], { adapterTimeoutMs: 10 });
  const events = [];
  registry.events.subscribe((event) => events.push(event));

  await registry.refresh();
  assert.equal(registry.adapterHealth()[0].status, "timeout");
  const eventCountAfterTimeout = events.length;
  const repeatedRefresh = registry.refresh();
  firstGate.resolve([{ id: "late:stale", provider: "test", source: "late", name: "stale", status: "idle", capabilities: {} }]);
  await repeatedRefresh;
  await nextTurn();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.adapterHealth()[0].status, "timeout");
  assert.equal(events.length, eventCountAfterTimeout);

  await registry.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(registry.list().map((agent) => agent.id), ["late:recovered"]);
  assert.equal(registry.adapterHealth()[0].status, "healthy");
});

test("preserves an adapter's last agents on failure and sanitizes health errors", async () => {
  let failing = false;
  const adapter = {
    id: "sometimes",
    async discover() {
      if (failing) throw new Error("  backend\n unavailable  ");
      return [{ id: "sometimes:1", provider: "test", source: "sometimes", name: "agent", status: "idle", capabilities: {} }];
    },
  };
  const registry = new AgentRegistry([adapter], { adapterTimeoutMs: 100 });
  await registry.refresh();
  const lastSuccessAt = registry.adapterHealth()[0].lastSuccessAt;

  failing = true;
  await registry.refresh();
  const [health] = registry.adapterHealth();
  assert.equal(registry.list()[0].id, "sometimes:1");
  assert.equal(health.status, "error");
  assert.equal(health.lastSuccessAt, lastSuccessAt);
  assert.deepEqual(health.error, { code: "discovery_failed", message: "backend unavailable" });
  assert.equal("stack" in health.error, false);
});

test("shutdown aborts and waits for an in-flight refresh", { timeout: 500 }, async () => {
  let closeCalls = 0;
  const adapter = {
    id: "abortable",
    discover({ signal }) {
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve([]), { once: true }));
    },
    async close() { closeCalls += 1; },
  };
  const registry = new AgentRegistry([adapter], { adapterTimeoutMs: 10_000 });
  const refresh = registry.refresh();
  await nextTurn();
  await registry.close();
  await refresh;
  assert.equal(closeCalls, 1);
  assert.equal(registry.closed, true);
  assert.equal(registry.refreshing, false);
});

test("ignores non-cooperative discovery completion after shutdown", { timeout: 500 }, async () => {
  const gate = deferred();
  const adapter = { id: "late-close", async discover() { return gate.promise; } };
  const registry = new AgentRegistry([adapter], { adapterTimeoutMs: 10_000 });
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  const refresh = registry.refresh();
  await nextTurn();
  await registry.close();
  await refresh;

  gate.resolve([{ id: "late-close:1", provider: "test", source: "late-close", name: "late", status: "idle", capabilities: {} }]);
  await nextTurn();
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(events, []);
});

test("adapter circuit backs off, opens, probes once, and recovers with a fake clock", async () => {
  let clock = 0;
  let calls = 0;
  let failing = true;
  const adapter = {
    id: "fixture",
    async discover() {
      calls += 1;
      if (failing) throw new Error("fixture failure");
      return [];
    },
  };
  const registry = new AgentRegistry([adapter], {
    now: () => clock,
    circuitBaseMs: 10,
    circuitMaxMs: 40,
    circuitThreshold: 3,
    forcedProbeMinMs: 5,
  });

  await registry.refresh({ force: false });
  clock = 10;
  await registry.refresh({ force: false });
  clock = 30;
  await registry.refresh({ force: false });
  assert.equal(calls, 3);
  assert.equal(registry.adapterHealth()[0].circuit.phase, "open");

  clock = 31;
  await registry.refresh({ force: false });
  assert.equal(calls, 3);
  await registry.refresh({ force: true });
  assert.equal(calls, 4);
  assert.equal(registry.adapterHealth()[0].circuit.phase, "open");

  failing = false;
  clock += 5;
  await registry.refresh({ force: true });
  assert.equal(calls, 5);
  assert.deepEqual(registry.adapterHealth()[0].circuit, {
    phase: "closed", consecutiveFailures: 0, nextAttemptAt: null,
  });
  await registry.close();
});

test("explicit refresh queued during a scheduled refresh is not swallowed", async () => {
  let calls = 0;
  const gate = deferred();
  const adapter = {
    id: "fixture",
    async discover() {
      calls += 1;
      if (calls === 1) await gate.promise;
      return [];
    },
  };
  const registry = new AgentRegistry([adapter]);
  const scheduled = registry.refresh({ force: false });
  const explicit = registry.refresh({ force: true });
  gate.resolve();
  await scheduled;
  await explicit;
  assert.equal(calls, 2);
  await registry.close();
});
