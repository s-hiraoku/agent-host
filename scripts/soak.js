#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AgentRegistry } from "../src/core/registry.js";
import { ActionExecutor } from "../src/http/action-executor.js";
import { SseClient, MAX_SSE_PENDING_EVENTS } from "../src/http/sse-client.js";
import { OperationsContext } from "../src/operations/context.js";
import { DEFAULT_RECENT_LOG_LIMIT } from "../src/operations/logger.js";

export async function runSoak({ cycles = 28_800, agentCount = 1_000 } = {}) {
  if (!Number.isSafeInteger(cycles) || cycles < 1) throw new RangeError("cycles must be a positive safe integer");
  if (!Number.isSafeInteger(agentCount) || agentCount < 1) throw new RangeError("agentCount must be a positive safe integer");
  let clock = 0;
  let cycle = 0;
  let childProcesses = 0;
  let childStarts = 0;
  let peakChildProcesses = 0;
  const agents = Array.from({ length: agentCount }, (_, index) => ({
    id: `soak:${index}`,
    provider: "fixture",
    source: "codex",
    name: `Soak agent ${index}`,
    status: index % 20 === 0 ? "working" : "idle",
    capabilities: { prompt: true },
    discovery: { kind: "native", confidence: "high", visibility: "active" },
  }));
  const operations = new OperationsContext({ logLevel: "debug" });
  const adapter = {
    id: "codex",
    async discover() {
      if (!childProcesses) {
        childProcesses = 1;
        childStarts += 1;
        peakChildProcesses = Math.max(peakChildProcesses, childProcesses);
      }
      if (cycle % 2_000 >= 1_000 && cycle % 2_000 < 1_003) {
        childProcesses = 0;
        throw new Error("injected transport exit");
      }
      return agents;
    },
    async prompt(agent) { return { ok: true, agentId: agent.id, action: "prompt" }; },
    async close() { childProcesses = 0; },
  };
  const registry = new AgentRegistry([adapter], {
    operations,
    now: () => clock,
    circuitBaseMs: 10,
    circuitMaxMs: 100,
  });
  const actions = new ActionExecutor(registry, { operations, idempotencyNow: () => clock });
  const baselineHandles = activeHandles();
  const samples = [];
  let maxSsePending = 0;
  let maxActionQueue = 0;

  for (cycle = 0; cycle < cycles; cycle += 1) {
    clock += 1_000;
    await registry.refresh({ force: false });
    if (cycle % 250 === 0) {
      const action = actions.execute("soak:0", "prompt", { text: "redacted soak payload" }, `soak-action-${cycle}`);
      maxActionQueue = Math.max(maxActionQueue, actions.queueDepth);
      await action;
    }
    if (cycle % 500 === 0) {
      const response = new SoakResponse();
      response.writable = false;
      const client = new SseClient(response, { operations });
      client.send("accepted");
      for (let event = 0; event <= MAX_SSE_PENDING_EVENTS; event += 1) {
        client.send(`event: fixture\ndata: ${event}\n\n`);
        maxSsePending = Math.max(maxSsePending, client.pendingEvents);
      }
      client.close();
    }
    if (cycle % 1_000 === 0 || cycle === cycles - 1) {
      global.gc?.();
      samples.push({ cycle, ...process.memoryUsage(), handles: activeHandles() });
    }
  }

  await actions.shutdown({ graceMs: 10 });
  await registry.close();
  operations.close();
  global.gc?.();
  const diagnostics = operations.snapshot();
  const finalHandles = activeHandles();
  const heapSlopeBytesPerCycle = slope(samples.slice(Math.floor(samples.length / 2)), "heapUsed");
  const heapGrowthBytes = samples.length > 1 ? samples.at(-1).heapUsed - samples[0].heapUsed : 0;
  const result = {
    passed: true,
    cycles,
    agentCount,
    samples,
    trends: { heapSlopeBytesPerCycle, heapGrowthBytes },
    bounds: {
      recentLogs: diagnostics.recentLogs.length,
      metricSeries: diagnostics.metrics.seriesCount,
      maxSsePending,
      maxActionQueue,
      baselineHandles,
      finalHandles,
      childProcesses,
      childStarts,
      peakChildProcesses,
    },
  };
  const failures = [];
  if (diagnostics.recentLogs.length > DEFAULT_RECENT_LOG_LIMIT) failures.push("recent log ring exceeded its bound");
  if (maxSsePending > MAX_SSE_PENDING_EVENTS) failures.push("SSE queue exceeded its event bound");
  if (maxActionQueue > 256) failures.push("action queue exceeded its global bound");
  if (diagnostics.metrics.seriesCount > 32) failures.push("metric series cardinality exceeded 32");
  if (childProcesses !== 0) failures.push("tracked child processes remained after shutdown");
  if (finalHandles > baselineHandles + 2) failures.push("active handles grew after shutdown");
  if (global.gc && heapGrowthBytes > 32 * 1024 * 1024) failures.push("GC-normalized heap grew by more than 32 MiB");
  if (global.gc && heapSlopeBytesPerCycle > 1_024) failures.push("late-run heap slope exceeded 1 KiB per cycle");
  result.passed = failures.length === 0;
  result.failures = failures;
  return result;
}

class SoakResponse extends EventEmitter {
  writable = true;
  writableEnded = false;
  write() { return this.writable; }
  end() { this.writableEnded = true; this.emit("close"); }
}

function activeHandles() {
  return process._getActiveHandles?.().filter((handle) => ![process.stdin, process.stdout, process.stderr].includes(handle)).length ?? 0;
}

function slope(samples, field) {
  if (samples.length < 2) return 0;
  const count = samples.length;
  const sumX = samples.reduce((sum, sample) => sum + sample.cycle, 0);
  const sumY = samples.reduce((sum, sample) => sum + sample[field], 0);
  const sumXY = samples.reduce((sum, sample) => sum + sample.cycle * sample[field], 0);
  const sumXX = samples.reduce((sum, sample) => sum + sample.cycle ** 2, 0);
  return (count * sumXY - sumX * sumY) / (count * sumXX - sumX ** 2 || 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cycles = Number(process.argv.find((arg) => arg.startsWith("--cycles="))?.split("=")[1] ?? 28_800);
  const result = await runSoak({ cycles });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
