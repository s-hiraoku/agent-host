import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEventBus } from "../src/core/event-bus.js";
import { LaunchCoordinator } from "../src/core/launch-coordinator.js";
import { LaunchLedger } from "../src/core/launch-ledger.js";
import { AgentRegistry } from "../src/core/registry.js";
import { DemoAdapter, DemoLaunchAdapter } from "../src/adapters/demo.js";
import { createAgentServer } from "../src/http/server.js";

const TOKEN = "launch-test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const LOCAL_REQUEST = {
  provider: "demo",
  target: "demo:workspace",
  profile: "default",
  mode: "local",
  confirmations: { localMutation: true, externalBillable: false },
};

test("launch coordinator persists idempotency and converges concurrent requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-coordinator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const registry = fixtureRegistry({
    async launch(_provider, record) {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ownedResult(record);
    },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();

  const [first, duplicate] = await Promise.all([
    coordinator.submit(LOCAL_REQUEST, "same-launch-key"),
    coordinator.submit(LOCAL_REQUEST, "same-launch-key"),
  ]);
  assert.equal(first.launch.id, duplicate.launch.id);
  assert.equal([first.replayed, duplicate.replayed].filter(Boolean).length, 1);
  await waitFor(() => coordinator.get(first.launch.id)?.state === "owned" && registry.owned.length === 1);
  assert.equal(calls, 1);
  assert.equal(registry.owned.length, 1);

  await assert.rejects(
    coordinator.submit({
      ...LOCAL_REQUEST,
      mode: "cloud",
      confirmations: { localMutation: false, externalBillable: true },
    }, "same-launch-key"),
    (error) => error.code === "idempotency_conflict",
  );
  await assert.rejects(
    coordinator.submit({ ...LOCAL_REQUEST, profile: "missing" }, "different-key"),
    (error) => error.code === "launch_option_not_found",
  );
  await assert.rejects(
    coordinator.submit({ ...LOCAL_REQUEST, confirmations: { localMutation: false, externalBillable: false } }, "another-key"),
    (error) => error.code === "launch_confirmation_mismatch",
  );
  await assert.rejects(
    coordinator.submit({ ...LOCAL_REQUEST, unexpected: true }, "unexpected-field"),
    (error) => error.code === "invalid_launch_request",
  );
  const stored = await readFile(join(directory, "launches.json"), "utf8");
  assert.equal(stored.includes("same-launch-key"), false);
  assert.equal(stored.includes(TOKEN), false);
  await coordinator.stop();
});

test("launch retirement fences provider deletion and replays from a bounded tombstone", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let retireCalls = 0;
  let deactivated;
  let finalized;
  const registry = fixtureRegistry();
  registry.retireLaunch = async (...args) => {
    retireCalls += 1;
    assert.equal(args[1].state, "retiring");
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = (id) => { deactivated = id; };
  registry.finalizeLaunchRetirement = async (entry) => { finalized = entry; return true; };
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "retirement-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "retirement-launch-key",
    ),
    (error) => error.code === "idempotency_conflict",
  );
  const lifecycle = [];
  registry.events.subscribe((event) => {
    if (event.type === "launch.updated" && event.launch.id === accepted.launch.id) lifecycle.push(event);
  });
  const payload = { confirmDeleteOwnedAgentAndState: true };
  const first = await coordinator.retire(accepted.launch.id, payload, "retirement-delete-key");
  assert.equal(first.replayed, false);
  assert.equal(first.retirement.state, "retired");
  assert.equal(coordinator.get(accepted.launch.id), undefined);
  assert.equal(deactivated, accepted.launch.id);
  assert.equal(finalized.launchId, accepted.launch.id);
  assert.deepEqual(lifecycle
    .filter((event) => ["retiring", "retired"].includes(event.phase))
    .map((event) => [event.phase, event.launch.state]), [
    ["retiring", "retiring"],
    ["retired", "retired"],
  ]);
  const replay = await coordinator.retire(accepted.launch.id, payload, "retirement-delete-key");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.retirement, first.retirement);
  assert.equal(retireCalls, 1);
  const creationReplay = await coordinator.submit(LOCAL_REQUEST, "retirement-launch-key");
  assert.equal(creationReplay.replayed, true);
  assert.equal(creationReplay.launch.id, accepted.launch.id);
  assert.equal(creationReplay.launch.state, "retired");
  await assert.rejects(
    coordinator.submit(LOCAL_REQUEST, "retirement-delete-key"),
    (error) => error.code === "idempotency_conflict",
  );
  await assert.rejects(
    coordinator.submit({ ...LOCAL_REQUEST, profile: "other" }, "retirement-launch-key"),
    (error) => error.code === "idempotency_conflict",
  );
  await assert.rejects(
    coordinator.retire(accepted.launch.id, payload, "different-retirement-key"),
    (error) => error.code === "idempotency_conflict",
  );
  await coordinator.stop();
});

test("ambiguous launch retirement stays fenced and resumes after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const firstRegistry = fixtureRegistry();
  firstRegistry.retireLaunch = async () => ({ status: "uncertain" });
  firstRegistry.deactivateOwnedLaunch = () => {};
  const first = new LaunchCoordinator(firstRegistry, { ledgerFile });
  await first.start();
  const accepted = await first.submit(LOCAL_REQUEST, "recovery-launch-key");
  await waitFor(() => first.get(accepted.launch.id)?.state === "owned");
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  await assert.rejects(
    first.retire(accepted.launch.id, confirmation, "recovery-retirement-key"),
    (error) => error.code === "launch_retirement_uncertain" && error.status === 503,
  );
  assert.equal(first.get(accepted.launch.id).state, "retiring");
  await first.stop();

  let resumed = 0;
  let finalized;
  const secondRegistry = fixtureRegistry();
  secondRegistry.retireLaunch = async (_provider, record) => {
    resumed += 1;
    assert.equal(record.state, "retiring");
    return { status: "retired" };
  };
  secondRegistry.deactivateOwnedLaunch = () => {};
  secondRegistry.finalizeLaunchRetirement = async (entry) => { finalized = entry; return true; };
  const second = new LaunchCoordinator(secondRegistry, { ledgerFile });
  await second.start();
  await waitFor(() => second.get(accepted.launch.id) === undefined && finalized);
  assert.equal(resumed, 1);
  const replay = await second.retire(
    accepted.launch.id, confirmation, "recovery-retirement-key",
  );
  assert.equal(replay.replayed, true);
  await second.stop();
});

test("a retry of an uncertain fenced retirement is reported as replayed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-replayed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => ({ status: ++calls === 1 ? "uncertain" : "retired" });
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "replayed-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  await assert.rejects(
    coordinator.retire(accepted.launch.id, confirmation, "replayed-retirement-key"),
    (error) => error.code === "launch_retirement_uncertain",
  );
  const replay = await coordinator.retire(
    accepted.launch.id, confirmation, "replayed-retirement-key",
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.retirement.state, "retired");
  await coordinator.stop();
});

test("shutdown aborts a retirement waiting for post-deactivation discovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-shutdown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let refreshStarted = false;
  let retireCalls = 0;
  const registry = fixtureRegistry();
  registry.deactivateOwnedLaunch = () => {};
  registry.refreshAfterOwnedLaunchChange = async () => {
    refreshStarted = true;
    await new Promise(() => {});
  };
  registry.retireLaunch = async () => { retireCalls += 1; return { status: "retired" }; };
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "shutdown-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const retirement = coordinator.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "shutdown-retirement-key",
  );
  const retirementOutcome = retirement.then(
    () => undefined,
    (error) => error,
  );
  await waitFor(() => refreshStarted);
  await Promise.race([
    coordinator.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("coordinator stop exceeded bound")), 100)),
  ]);
  assert.match((await retirementOutcome).message, /shutting down/);
  assert.equal(retireCalls, 0);
});

test("retirement cleanup survives replay-tombstone eviction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const firstRegistry = fixtureRegistry();
  firstRegistry.retireLaunch = async () => ({ status: "retired" });
  firstRegistry.deactivateOwnedLaunch = () => {};
  firstRegistry.finalizeLaunchRetirement = async () => { throw new Error("cleanup unavailable"); };
  const first = new LaunchCoordinator(firstRegistry, { ledgerFile });
  await first.start();
  const accepted = await first.submit(LOCAL_REQUEST, "cleanup-launch-key");
  await waitFor(() => first.get(accepted.launch.id)?.state === "owned");
  await first.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "cleanup-retirement-key",
  );
  await first.stop();
  const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(persisted.retirementCleanups.length, 1);
  persisted.retirements = [];
  await writeFile(ledgerFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const disabled = new LaunchCoordinator(fixtureRegistry(), { ledgerFile });
  await disabled.start();
  await disabled.stop();
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).retirementCleanups.length, 1);

  let cleanup;
  const secondRegistry = fixtureRegistry();
  secondRegistry.finalizeLaunchRetirement = async (entry) => { cleanup = entry; return true; };
  const second = new LaunchCoordinator(secondRegistry, { ledgerFile });
  await second.start();
  assert.equal(cleanup.launchId, accepted.launch.id);
  await second.stop();
  const cleaned = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.deepEqual(cleaned.retirementCleanups, []);
});

test("a pre-delete retirement refusal restores owned launch state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-blocked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => ({ status: "blocked", code: "agent_working" });
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "blocked-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const lifecycle = [];
  registry.events.subscribe((event) => {
    if (event.type === "launch.updated" && event.launch.id === accepted.launch.id) lifecycle.push(event);
  });
  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "blocked-retirement-key",
    ),
    (error) => error.code === "launch_not_retirable" && error.status === 409,
  );
  assert.equal(coordinator.get(accepted.launch.id).state, "owned");
  assert.deepEqual(lifecycle
    .filter((event) => ["retiring", "owned"].includes(event.phase))
    .slice(-2)
    .map((event) => [event.phase, event.launch.state]), [
    ["retiring", "retiring"],
    ["owned", "owned"],
  ]);
  await coordinator.stop();
});

test("concurrent retirement cannot cross-replay a different idempotency key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  let calls = 0;
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "race-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  const first = coordinator.retire(accepted.launch.id, confirmation, "race-retirement-key-a");
  await waitFor(() => calls === 1);
  await assert.rejects(
    coordinator.retire(accepted.launch.id, confirmation, "race-retirement-key-b"),
    (error) => error.code === "idempotency_conflict",
  );
  release();
  assert.equal((await first).retirement.state, "retired");
  assert.equal(calls, 1);
  await coordinator.stop();
});

test("a retirement idempotency key cannot be reused across launch IDs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-global-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  let calls = 0;
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const firstLaunch = await coordinator.submit(LOCAL_REQUEST, "global-key-launch-a");
  const secondLaunch = await coordinator.submit(LOCAL_REQUEST, "global-key-launch-b");
  await waitFor(() => coordinator.get(firstLaunch.launch.id)?.state === "owned"
    && coordinator.get(secondLaunch.launch.id)?.state === "owned");
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  const first = coordinator.retire(firstLaunch.launch.id, confirmation, "global-retirement-key");
  await waitFor(() => calls === 1);
  await assert.rejects(
    coordinator.retire(secondLaunch.launch.id, confirmation, "global-retirement-key"),
    (error) => error.code === "idempotency_conflict",
  );
  release();
  await first;
  await assert.rejects(
    coordinator.retire(secondLaunch.launch.id, confirmation, "global-retirement-key"),
    (error) => error.code === "idempotency_conflict",
  );
  assert.equal(calls, 1);
  await coordinator.stop();
});

test("uncertain launch delivery is reconciled without blind create retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-uncertain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  let creates = 0;
  let finishLate;
  const firstRegistry = fixtureRegistry({
    launch(_provider, record) {
      creates += 1;
      return new Promise((resolve) => { finishLate = () => resolve(ownedResult(record)); });
    },
  });
  const first = new LaunchCoordinator(firstRegistry, { ledgerFile, launchTimeoutMs: 10 });
  await first.start();
  const accepted = await first.submit(LOCAL_REQUEST, "uncertain-launch");
  await waitFor(() => first.get(accepted.launch.id)?.state === "uncertain");
  const queued = await first.submit(LOCAL_REQUEST, "uncertain-launch-next");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creates, 1);
  assert.equal(first.get(queued.launch.id).state, "requested");
  await first.stop();

  let reconciles = 0;
  const secondRegistry = fixtureRegistry({
    launch(_provider, record) { creates += 1; return ownedResult(record); },
    async reconcileLaunch() { reconciles += 1; return { status: "unsupported" }; },
  });
  const second = new LaunchCoordinator(secondRegistry, { ledgerFile, launchTimeoutMs: 10 });
  await assert.rejects(second.start(), (error) => error.code === "instance_already_running");
  finishLate();
  await waitFor(async () => lstat(`${ledgerFile}.writer.lock`).then(() => false, (error) => error.code === "ENOENT"));
  await second.start();
  await waitFor(() => reconciles === 1 && creates === 2);
  const replay = await second.submit(LOCAL_REQUEST, "uncertain-launch");
  assert.equal(replay.replayed, true);
  assert.equal(replay.launch.id, accepted.launch.id);
  assert.equal(second.get(accepted.launch.id).state, "uncertain");
  await waitFor(() => second.get(queued.launch.id)?.state === "owned");
  assert.equal(creates, 2);
  await second.stop();
});

test("startup reconciles a persisted creating record and activates ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const ledger = new LaunchLedger(ledgerFile);
  await ledger.open();
  const reserved = await ledger.reserve({
    keyHash: "a".repeat(43), signature: "b".repeat(43), request: resolvedRequest(),
  });
  await ledger.transition(reserved.record.id, ["requested"], { state: "creating" });
  await ledger.close();

  let reconciles = 0;
  let reconciledAttempt;
  const registry = fixtureRegistry({
    async reconcileLaunch(_provider, record) {
      reconciles += 1;
      reconciledAttempt = record.attemptId;
      return ownedResult(record);
    },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile });
  await coordinator.start();
  await waitFor(() => coordinator.get(reserved.record.id)?.state === "owned" && registry.owned.length === 1);
  assert.equal(reconciles, 1);
  assert.equal(reconciledAttempt, reserved.record.attemptId);
  assert.equal(registry.owned[0].id, reserved.record.id);
  await coordinator.stop();
});

test("invalid provider success cannot establish ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-invalid-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = fixtureRegistry({
    async launch() { return { status: "owned", providerAgentId: "../../foreign", agentId: "demo:unproven" }; },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "invalid-provider-result");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "uncertain");
  assert.equal(coordinator.get(accepted.launch.id).error.code, "launch_invalid_result");
  assert.equal(registry.owned.length, 0);
  await coordinator.stop();
});

test("launch ledger rejects corrupt and linked state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corrupt = join(directory, "corrupt.json");
  await writeFile(corrupt, '{"schemaVersion":99,"records":[]}\n', { mode: 0o600 });
  await assert.rejects(new LaunchLedger(corrupt).open(), /unsupported or malformed/);

  const extra = join(directory, "extra.json");
  const record = {
    id: "launch:00000000-0000-4000-8000-000000000000",
    attemptId: "attempt:00000000-0000-4000-8000-000000000001",
    keyHash: "a".repeat(43), signature: "b".repeat(43), request: resolvedRequest(), state: "requested",
    requestedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", secret: "reject-me",
  };
  await writeFile(extra, `${JSON.stringify({ schemaVersion: 1, records: [record] })}\n`, { mode: 0o600 });
  await assert.rejects(new LaunchLedger(extra).open(), /unsupported or malformed/);

  const target = join(directory, "target.json");
  const linked = join(directory, "linked.json");
  await writeFile(target, '{"schemaVersion":1,"records":[]}\n', { mode: 0o600 });
  await symlink(target, linked);
  await assert.rejects(new LaunchLedger(linked).open(), /invalid or unavailable/);
});

test("launch ledger admits only one writer for a state directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "launches.json");
  const first = new LaunchLedger(path);
  const second = new LaunchLedger(path);
  await first.open();
  await assert.rejects(second.open(), (error) => error.code === "instance_already_running");
  await first.close();
  await second.open();
  await second.close();
});

test("launch admission is bounded before durable intent grows without limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = fixtureRegistry({ launch: async () => ({ status: "uncertain", code: "provider_timeout" }) });
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"), launchTimeoutMs: 60_000,
  });
  await coordinator.start();
  const ids = [];
  for (let index = 0; index < 32; index += 1) {
    const accepted = await coordinator.submit(LOCAL_REQUEST, `bounded-launch-${String(index).padStart(2, "0")}`);
    assert.equal(accepted.replayed, false);
    ids.push(accepted.launch.id);
    await waitFor(() => coordinator.get(accepted.launch.id)?.state === "uncertain");
  }
  await assert.rejects(
    coordinator.submit(LOCAL_REQUEST, "bounded-launch-overflow"),
    (error) => error.code === "launch_queue_full" && error.status === 429,
  );
  await coordinator.stop();

  const recovered = new LaunchCoordinator(fixtureRegistry({
    async reconcileLaunch() { return { status: "failed", code: "provider_proved_absent" }; },
  }), { ledgerFile: join(directory, "launches.json") });
  await recovered.start();
  await waitFor(() => ids.every((id) => recovered.get(id)?.state === "failed"), 10_000);
  const afterResolution = await recovered.submit(LOCAL_REQUEST, "bounded-after-resolution");
  assert.equal(afterResolution.replayed, false);
  await recovered.stop();
});

test("provider exceptions remain uncertain and never leak through public state or events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-secret-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "/private/workspace api-key-secret provider-agent-123";
  const registry = fixtureRegistry({ launch: async () => { throw new Error(secret); } });
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  const logs = [];
  const operations = {
    logger: { log(...args) { logs.push(args); } },
    metrics: { increment() {}, setGauge() {}, observe() {} },
  };
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"), operations,
  });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "provider-secret-error");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "uncertain");
  const serialized = JSON.stringify({ launch: coordinator.get(accepted.launch.id), events, logs });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("provider-agent-123"), false);
  assert.equal(coordinator.get(accepted.launch.id).error.code, "launch_delivery_uncertain");
  await coordinator.stop();
});

test("startup reconciliation obeys the global concurrency bound", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-reconcile-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const ledger = new LaunchLedger(ledgerFile);
  await ledger.open();
  for (let index = 0; index < 6; index += 1) {
    const request = { ...resolvedRequest(), provider: `provider-${index}` };
    const reserved = await ledger.reserve({
      keyHash: String.fromCharCode(65 + index).repeat(43),
      signature: String.fromCharCode(75 + index).repeat(43),
      request,
    });
    await ledger.transition(reserved.record.id, ["requested"], { state: "creating" });
    await ledger.transition(reserved.record.id, ["creating"], {
      state: "uncertain", error: { code: "seeded_uncertain", retryable: true },
    });
  }
  await ledger.close();

  let active = 0;
  let maximum = 0;
  let calls = 0;
  const registry = fixtureRegistry({
    async reconcileLaunch() {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "unsupported" };
    },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile });
  await coordinator.start();
  await waitFor(() => calls === 6);
  assert.equal(maximum, 4);
  await coordinator.stop();
});

test("a stuck provider lane does not block reconciliation for another provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-provider-lanes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const ledger = new LaunchLedger(ledgerFile);
  await ledger.open();
  const ids = {};
  for (const [index, provider] of ["provider-a", "provider-b"].entries()) {
    const reserved = await ledger.reserve({
      keyHash: String.fromCharCode(65 + index).repeat(43),
      signature: String.fromCharCode(75 + index).repeat(43),
      request: { ...resolvedRequest(), provider },
    });
    ids[provider] = reserved.record.id;
    await ledger.transition(reserved.record.id, ["requested"], { state: "creating" });
    await ledger.transition(reserved.record.id, ["creating"], {
      state: "uncertain", error: { code: "seeded_uncertain", retryable: true },
    });
  }
  await ledger.close();

  let finishProviderA;
  let providerBCalls = 0;
  const registry = fixtureRegistry({
    reconcileLaunch(provider) {
      if (provider === "provider-a") return new Promise((resolve) => { finishProviderA = resolve; });
      providerBCalls += 1;
      return { status: "unsupported" };
    },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile, launchTimeoutMs: 10 });
  await coordinator.start();
  await waitFor(() => providerBCalls === 1 && coordinator.get(ids["provider-a"])?.state === "uncertain");
  await coordinator.stop();
  finishProviderA({ status: "owned", providerAgentId: "late:provider", agentId: "late:agent" });
  await waitFor(async () => lstat(`${ledgerFile}.writer.lock`).then(() => false, (error) => error.code === "ENOENT"));
});

test("registry rejects owned discovery results that are not proven by the ledger", async () => {
  const adapter = {
    id: "malicious",
    launchCapabilities: () => ({
      provider: "demo", capabilityVersion: "demo-v1",
      targets: [{ id: "demo:workspace", profiles: ["default"], modes: [
        { id: "local", enabled: true, localMutation: true, externalBillable: false },
      ] }],
    }),
    async discover() {
      return [{ id: "demo:ordinary-unowned", provider: "demo", source: "malicious", name: "unowned", status: "idle" }];
    },
    async discoverOwned() {
      return [{ id: "demo:unowned", provider: "demo", source: "malicious", name: "unowned", status: "idle" }];
    },
  };
  const registry = new AgentRegistry([adapter]);
  registry.activateOwnedLaunch({
    id: "launch:proof", state: "owned", agentId: "demo:expected", providerAgentId: "provider:expected",
    request: resolvedRequest(),
  });
  await registry.refresh();
  assert.equal(registry.get("demo:unowned"), undefined);
  assert.equal(registry.get("demo:ordinary-unowned"), undefined);
  assert.equal(registry.get("demo:expected"), undefined);
  assert.equal(registry.readiness().degraded, true);
  await registry.close();
});

test("internal launch adapter health preserves public discovery compatibility and degraded readiness", async () => {
  const registry = new AgentRegistry([{
    id: "public",
    async discover() { return []; },
  }, {
    id: "internal-launch",
    discoveryHealth: "internal",
    launchCapabilities: () => ({ provider: "demo", capabilityVersion: "demo-v1", targets: [] }),
    async discover() { throw new Error("launch discovery unavailable"); },
    async discoverOwned() { return []; },
  }]);
  await registry.refresh();
  assert.deepEqual(registry.adapterHealth().map((health) => health.id), ["public"]);
  assert.deepEqual(registry.adapterHealth({ includeInternal: true }).map((health) => health.id), [
    "public", "internal-launch",
  ]);
  assert.equal(registry.readiness().degraded, true);
  await registry.close();
});

test("HTTP disconnect does not cancel an issued launch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-disconnect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let issued;
  let finish;
  const registry = fixtureRegistry({
    launch(_provider, record) {
      issued?.(record);
      return new Promise((resolve) => { finish = () => resolve(ownedResult(record)); });
    },
  });
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(directory, "launches.json") });
  const serverRegistry = { ...registry, revision: 0, readiness: () => ({ ready: true, adapters: [] }), close: async () => {} };
  const server = createAgentServer(serverRegistry, {
    host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: TOKEN, launchCoordinator: coordinator,
  });
  const address = await server.start();
  let issuedRecord;
  const started = new Promise((resolve) => { issued = (record) => { issuedRecord = record; resolve(); }; });
  const body = JSON.stringify(LOCAL_REQUEST);
  const req = httpRequest({
    host: "127.0.0.1", port: address.port, path: "/v1/launches", method: "POST",
    headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "disconnect-launch", "content-length": Buffer.byteLength(body) },
  });
  req.on("error", () => {});
  req.end(body);
  await started;
  req.destroy();
  finish();
  await waitFor(() => coordinator.get(issuedRecord.id)?.state === "owned" && registry.owned.length === 1);
  await server.stop();
});

test("authenticated launch retirement route requires JSON confirmation and an idempotency key", async () => {
  const registry = new AgentRegistry([new DemoAdapter()]);
  const audits = [];
  registry.events.subscribe((event) => { if (event.type === "audit.action") audits.push(event); });
  const calls = [];
  const launchCoordinator = {
    capabilities: () => ({ version: "1", providers: [] }),
    async start() {},
    async stop() {},
    get() {},
    async submit() {},
    async retire(id, payload, key) {
      calls.push({ id, payload, key });
      if (!key) throw Object.assign(new Error("missing"), {
        name: "ContractError", code: "invalid_idempotency_key", status: 400,
      });
      return {
        retirement: { launchId: id, state: "retired", retiredAt: "2026-08-25T00:00:00.000Z" },
        replayed: false,
      };
    },
  };
  const server = createAgentServer(registry, {
    host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: TOKEN, launchCoordinator,
  });
  const address = await server.start();
  const endpoint = `http://127.0.0.1:${address.port}/v1/launches/${encodeURIComponent("launch:owned")}/retire`;
  try {
    assert.equal((await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status, 401);
    const malformedResponse = await fetch(`http://127.0.0.1:${address.port}/v1/launches/%ZZ/retire`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "malformed-retire-key" },
      body: JSON.stringify({ confirmDeleteOwnedAgentAndState: true }),
    });
    assert.equal(malformedResponse.status, 400);
    assert.equal((await malformedResponse.json()).error.code, "invalid_launch_id");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "retire-route-key" },
      body: JSON.stringify({ confirmDeleteOwnedAgentAndState: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      apiVersion: "1",
      retirement: {
        launchId: "launch:owned", state: "retired", retiredAt: "2026-08-25T00:00:00.000Z",
      },
      replayed: false,
    });
    assert.deepEqual(calls, [{
      id: "launch:owned",
      payload: { confirmDeleteOwnedAgentAndState: true },
      key: "retire-route-key",
    }]);
    assert.deepEqual(audits.map(({ phase, agentId, action, ok, replayed }) => ({
      phase, agentId, action, ok, replayed,
    })), [{
      phase: "attempted", agentId: "launch:owned", action: "retire-launch", ok: undefined, replayed: undefined,
    }, {
      phase: "completed", agentId: "launch:owned", action: "retire-launch", ok: true, replayed: false,
    }]);
    assert.equal(JSON.stringify(audits).includes("confirmDeleteOwnedAgentAndState"), false);
    assert.equal(JSON.stringify(audits).includes("retire-route-key"), false);
  } finally {
    await server.stop();
  }
});

test("authenticated launch API exposes only ledger-owned demo agents across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const first = await startDemoServer(ledgerFile);
  const base = `http://127.0.0.1:${first.address.port}`;
  let launchId;
  let agentId;
  try {
    assert.equal((await fetch(`${base}/v1/capabilities`)).status, 401);
    const capabilities = await (await fetch(`${base}/v1/capabilities`, { headers: AUTH })).json();
    assert.equal(capabilities.capabilities.launches.providers[0].provider, "demo");
    assert.deepEqual(capabilities.capabilities.launches.providers[0].targets[0].modes.map((mode) => mode.risk), [
      { localMutation: true, externalBillable: false },
      { localMutation: false, externalBillable: true },
    ]);

    const acceptedResponse = await fetch(`${base}/v1/launches`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "http-launch-key" },
      body: JSON.stringify(LOCAL_REQUEST),
    });
    assert.equal(acceptedResponse.status, 202);
    assert.equal(acceptedResponse.headers.get("cache-control"), "private, no-store");
    const accepted = await acceptedResponse.json();
    launchId = accepted.launch.id;
    assert.equal(acceptedResponse.headers.get("location"), `/v1/launches/${encodeURIComponent(launchId)}`);
    const owned = await waitForLaunch(base, launchId);
    agentId = owned.agentId;
    assert.equal(owned.state, "owned");
    await waitFor(async () => (await fetch(
      `${base}/v1/agents/${encodeURIComponent(agentId)}`, { headers: AUTH },
    )).status === 200);

    const replay = await (await fetch(`${base}/v1/launches`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "http-launch-key" },
      body: JSON.stringify(LOCAL_REQUEST),
    })).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.launch.id, launchId);
    assert.equal((await fetch(`${base}/v1/launches/missing`, { headers: AUTH })).status, 404);
    const missingKey = await fetch(`${base}/v1/launches`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(LOCAL_REQUEST),
    });
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json()).error.code, "invalid_idempotency_key");
    assert.equal(missingKey.headers.get("cache-control"), "private, no-store");
    assert.equal((await lstat(ledgerFile)).mode & 0o777, 0o600);
  } finally {
    await first.server.stop();
  }

  const second = await startDemoServer(ledgerFile);
  const restartedBase = `http://127.0.0.1:${second.address.port}`;
  try {
    const launch = await (await fetch(
      `${restartedBase}/v1/launches/${encodeURIComponent(launchId)}`, { headers: AUTH },
    )).json();
    assert.equal(launch.launch.state, "owned");
    await waitFor(async () => (await fetch(
      `${restartedBase}/v1/agents/${encodeURIComponent(agentId)}`, { headers: AUTH },
    )).status === 200);
  } finally {
    await second.server.stop();
  }
});

function fixtureRegistry(overrides = {}) {
  const registry = {
    events: new AgentEventBus(),
    owned: [],
    launchCapabilities: () => [new DemoLaunchAdapter().launchCapabilities()],
    async launch(provider, record, options) {
      return overrides.launch?.(provider, record, options) ?? ownedResult(record);
    },
    async reconcileLaunch(provider, record, options) {
      return overrides.reconcileLaunch?.(provider, record, options) ?? ownedResult(record);
    },
    activateOwnedLaunch(record) { this.owned.push(record); },
    async refresh() {},
  };
  return registry;
}

function ownedResult(record) {
  const suffix = String(record.attemptId).replace(/^attempt:/, "");
  return { status: "owned", providerAgentId: `provider:${suffix}`, agentId: `demo:owned:${suffix}` };
}

function resolvedRequest() {
  return {
    provider: LOCAL_REQUEST.provider,
    target: LOCAL_REQUEST.target,
    profile: LOCAL_REQUEST.profile,
    mode: LOCAL_REQUEST.mode,
    risk: { ...LOCAL_REQUEST.confirmations },
    capabilityVersion: "demo-v1",
  };
}

async function startDemoServer(ledgerFile) {
  const registry = new AgentRegistry([new DemoAdapter(), new DemoLaunchAdapter()]);
  const server = createAgentServer(registry, {
    host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: TOKEN, launchLedgerFile: ledgerFile,
  });
  const address = await server.start();
  return { registry, server, address };
}

async function waitForLaunch(base, id) {
  let launch;
  await waitFor(async () => {
    const response = await fetch(`${base}/v1/launches/${encodeURIComponent(id)}`, { headers: AUTH });
    launch = (await response.json()).launch;
    return launch?.state === "owned";
  });
  return launch;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}
