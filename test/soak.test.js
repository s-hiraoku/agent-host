import test from "node:test";
import assert from "node:assert/strict";
import { runSoak } from "../scripts/soak.js";

test("accelerated soak keeps queues, logs, metrics, handles, and children bounded", { timeout: 15_000 }, async () => {
  const result = await runSoak({ cycles: 2_000, agentCount: 250 });
  assert.equal(result.passed, true, result.failures.join("; "));
  assert.equal(result.cycles, 2_000);
  assert.ok(result.bounds.recentLogs <= 200);
  assert.ok(result.bounds.maxSsePending <= 64);
  assert.ok(result.bounds.maxActionQueue <= 256);
  assert.ok(result.bounds.metricSeries <= 32);
  assert.equal(result.bounds.childProcesses, 0);
  assert.ok(result.bounds.finalHandles <= result.bounds.baselineHandles + 2);
});
