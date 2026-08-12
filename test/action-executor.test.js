import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/http/action-executor.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("action executor bounds per-agent and global queues while coalescing idempotent retries", async () => {
  const gate = deferred();
  let calls = 0;
  const registry = {
    async action(agentId, action) {
      calls += 1;
      await gate.promise;
      return { ok: true, agentId, action };
    },
  };
  const executor = new ActionExecutor(registry, { maxActionsPerAgent: 2, maxActionsGlobal: 3 });
  const first = executor.execute("agent:1", "prompt", { text: "a" }, "bounded-action-1");
  const replay = executor.execute("agent:1", "prompt", { text: "a" }, "bounded-action-1");
  const second = executor.execute("agent:1", "prompt", { text: "b" }, "bounded-action-2");
  await assert.rejects(
    executor.execute("agent:1", "prompt", { text: "c" }, "bounded-action-3"),
    (error) => error.code === "queue_full" && error.status === 429,
  );
  const thirdAgent = executor.execute("agent:2", "prompt", { text: "c" }, "bounded-action-4");
  await assert.rejects(
    executor.execute("agent:3", "prompt", { text: "d" }, "bounded-action-5"),
    (error) => error.code === "queue_full",
  );
  assert.equal(executor.queueDepth, 3);
  gate.resolve();
  const [firstResult, replayResult] = await Promise.all([first, replay]);
  await Promise.all([second, thirdAgent]);
  assert.equal(firstResult.replayed, false);
  assert.equal(replayResult.replayed, true);
  assert.equal(calls, 3);
  assert.equal(executor.queueDepth, 0);
});

test("action executor rejects queued work and aborts active work at shutdown deadline", async () => {
  let activeAborted = false;
  const registry = {
    action(_agentId, _action, _payload, { signal }) {
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        activeAborted = true;
        resolve({ ok: false, code: "aborted" });
      }, { once: true }));
    },
  };
  const executor = new ActionExecutor(registry, { maxActionsPerAgent: 3 });
  const active = executor.execute("agent:1", "prompt", {}, "shutdown-action-1");
  const queued = executor.execute("agent:1", "prompt", {}, "shutdown-action-2");
  const queuedRejected = assert.rejects(queued, (error) => error.code === "shutting_down");
  await new Promise((resolve) => setImmediate(resolve));
  const state = await executor.shutdown({ graceMs: 1 });
  assert.equal(state.timedOut, true);
  await queuedRejected;
  await active;
  assert.equal(activeAborted, true);
  await assert.rejects(
    executor.execute("agent:1", "prompt", {}, "shutdown-action-3"),
    (error) => error.code === "shutting_down",
  );
});
