import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRedactor } from "../src/operations/redact.js";
import { MAX_LOG_RECORD_BYTES, StructuredLogger } from "../src/operations/logger.js";
import { OperationalMetrics } from "../src/operations/metrics.js";
import { OperationsContext } from "../src/operations/context.js";

test("central redaction bounds nested values and removes secrets, auth, paths, prompts, and URL credentials", () => {
  const redact = createRedactor({
    homeDirectory: "/Users/example",
    secrets: ["top-secret-token"],
    paths: ["/Volumes/private/control.sock"],
  });
  const circular = { safe: "ok" };
  circular.self = circular;
  const result = redact({
    authorization: "Bearer top-secret-token",
    context: "kept",
    commandCount: 2,
    environmentReady: true,
    nested: {
      message: "failed at /Users/example/project with Bearer abc.def and top-secret-token",
      prompt: "private request",
      url: "https://user:pass@example.test/path?token=hidden#fragment",
      socket: "/Volumes/private/control.sock failed",
      circular,
    },
    error: Object.assign(new Error("bad /Users/example/private"), { code: "EFAIL" }),
    huge: "x".repeat(1_000),
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.prompt, "[REDACTED]");
  assert.match(result.nested.message, /\$HOME\/project/);
  assert.match(result.nested.message, /Bearer \[REDACTED\]/);
  assert.equal(result.nested.url, "https://example.test/path");
  assert.equal(result.nested.socket, "$PATH/control.sock failed");
  assert.equal(result.nested.circular.self, "[CIRCULAR]");
  assert.equal(result.huge.length, 512);
  assert.doesNotMatch(serialized, /top-secret-token|private request|user:pass|token=hidden|Users\/example/);
  assert.equal(result.context, "kept");
  assert.equal(result.commandCount, 2);
  assert.equal(result.environmentReady, true);
});

test("structured logger writes parseable owner-only JSONL with bounded ring and rotation", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-operations-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const path = join(home, "state", "operations.jsonl");
  const logger = new StructuredLogger({
    path,
    level: "debug",
    recentLimit: 2,
    maxBytes: 240,
    generations: 3,
    redact: createRedactor({ secrets: ["secret-value"] }),
  });
  for (let index = 0; index < 8; index += 1) {
    logger.log("info", "fixture.event", { component: "test", details: { index, token: "secret-value" } });
  }
  assert.equal(logger.recent().length, 2);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(home, "state"))).mode & 0o777, 0o700);
  const files = [path, `${path}.1`, `${path}.2`];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.ok(lines.every((line) => JSON.parse(line)));
    assert.doesNotMatch(lines.join("\n"), /secret-value/);
  }
});

test("structured logger refuses a symbolic-link destination", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-log-link-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const target = join(home, "target");
  const link = join(home, "operations.jsonl");
  await writeFile(target, "");
  await chmod(target, 0o600);
  await symlink(target, link);
  assert.throws(() => new StructuredLogger({ path: link }), /regular file/);
});

test("structured logger caps a combinatorially large details object", () => {
  const logger = new StructuredLogger({ level: "debug" });
  const branch = () => Object.fromEntries(Array.from({ length: 32 }, (_, index) => [String(index), "x".repeat(512)]));
  const record = logger.log("info", "large.details", {
    details: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [String(index), branch()])),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= MAX_LOG_RECORD_BYTES);
  assert.deepEqual(record.details, { truncated: true });
});

for (const code of ["EACCES", "ENOSPC"]) {
  test(`structured logger survives and reports ${code} write failures without retry recursion`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), `agent-host-log-${code.toLowerCase()}-`));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
    let attempts = 0;
    const logger = new StructuredLogger({
      path: join(home, "operations.jsonl"),
      fileSystem: {
        appendFileSync() {
          attempts += 1;
          throw Object.assign(new Error("injected sink failure"), { code });
        },
      },
    });

    assert.doesNotThrow(() => logger.log("error", "fixture.failure", { component: "other" }));
    assert.doesNotThrow(() => logger.log("error", "fixture.after_failure", { component: "other" }));
    assert.equal(attempts, 1);
    assert.deepEqual(logger.sinkStatus(), {
      available: false,
      operation: "write",
      code,
      at: logger.sinkStatus().at,
    });
    assert.ok(logger.recent().some((record) => record.event === "logger.sink_failure" && record.code === code));
  });
}

test("structured logger survives and reports rotation rename failures", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-log-rename-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const path = join(home, "operations.jsonl");
  await writeFile(path, "existing record\n", { mode: 0o600 });
  const logger = new StructuredLogger({
    path,
    maxBytes: 1,
    fileSystem: {
      renameSync() { throw Object.assign(new Error("injected rename failure"), { code: "EIO" }); },
    },
  });

  assert.doesNotThrow(() => logger.log("error", "fixture.rotation", { component: "other" }));
  assert.equal(logger.sinkStatus().available, false);
  assert.equal(logger.sinkStatus().operation, "rotate");
  assert.equal(logger.sinkStatus().code, "EIO");
  assert.ok(logger.recent().some((record) => record.event === "logger.sink_failure"));
});

test("operational metrics use bounded fixed label series and cumulative histograms", () => {
  const metrics = new OperationalMetrics();
  metrics.increment("adapter_failures", { adapter: "codex", requestId: "unbounded-1" });
  metrics.increment("adapter_failures", { adapter: "unexpected", requestId: "unbounded-2" });
  metrics.observe("action_latency_ms", 25, { actionKind: "prompt", outcome: "success", agentId: "secret" });
  metrics.observe("action_latency_ms", 75, { actionKind: "prompt", outcome: "success", agentId: "different" });
  metrics.setGauge("event_subscribers", 3, { clientId: "ignored" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.seriesCount, 4);
  assert.equal(snapshot.histograms[0].value.count, 2);
  assert.equal(snapshot.histograms[0].value.sum, 100);
  assert.equal(snapshot.histograms[0].value.buckets.find((bucket) => bucket.upperBound === 100).count, 2);
  assert.equal(snapshot.histograms[0].value.buckets.at(-1).upperBound, "+Inf");
  assert.equal(snapshot.gauges[0].value, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /requestId|agentId|secret|different/);
  assert.throws(() => metrics.setGauge("event_subscribers", NaN), /finite value/);
  assert.throws(() => metrics.observe("action_latency_ms", Infinity), /finite value/);
});

test("diagnostics redaction preserves the bounded metric schema and values", () => {
  const operations = new OperationsContext();
  operations.metrics.observe("action_latency_ms", 75, { actionKind: "prompt", outcome: "success" });
  const snapshot = operations.snapshot();
  const histogram = snapshot.metrics.histograms[0];
  assert.equal(histogram.labels.actionKind, "prompt");
  assert.equal(histogram.value.count, 1);
  assert.equal(histogram.value.sum, 75);
  assert.equal(histogram.value.buckets.find((bucket) => bucket.upperBound === 100).count, 1);
});
