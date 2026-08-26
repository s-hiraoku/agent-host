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
    return { status: "retired", cleanupScope: "demo_scope_00001" };
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
  await waitFor(() => finalized?.launchId === accepted.launch.id);
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

test("ledger reservation replays a creation key retired after the caller precheck", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retired-reservation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new LaunchLedger(join(directory, "launches.json"));
  await ledger.open();
  const keyHash = "c".repeat(43);
  const signature = "s".repeat(43);
  const request = resolvedRequest();
  const reserved = await ledger.reserve({
    keyHash, signature, request, now: "2026-08-25T00:00:00.000Z",
  });
  await ledger.transition(reserved.record.id, ["requested"], {
    state: "owned", providerAgentId: "provider-agent", agentId: "demo:agent",
  }, "2026-08-25T00:01:00.000Z");
  await ledger.beginRetirement(
    reserved.record.id, "r".repeat(43), "2026-08-25T00:02:00.000Z",
  );
  const retired = await ledger.completeRetirement(
    reserved.record.id, "2026-08-24T23:59:00.000Z",
  );
  assert.equal(retired.retiredAt, "2026-08-25T00:02:00.000Z");
  const replay = await ledger.reserve({ keyHash, signature, request });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.retirement, retired);
  assert.equal(ledger.list().length, 0);
  await ledger.close();
});

test("retirement fencing reserves ledger capacity before provider deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const timestamp = "2026-08-25T00:00:00.000Z";
  const request = () => ({
    provider: "p", target: "t", profile: "p", mode: "m", capabilityVersion: "v",
    risk: { localMutation: true, externalBillable: false },
  });
  const identity = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const hash = (prefix, index) => `${prefix}${index.toString(36).padStart(42, "0")}`;
  const owned = {
    id: `launch:${identity(0)}`, attemptId: `attempt:${identity(0)}`,
    keyHash: hash("k", 0), signature: hash("s", 0), request: request(), state: "owned",
    requestedAt: timestamp, updatedAt: timestamp, providerAgentId: "provider", agentId: "agent",
  };
  const records = [owned];
  for (let index = 1; index < 1_000; index += 1) {
    records.push({
      id: `launch:${identity(index)}`, attemptId: `attempt:${identity(index)}`,
      keyHash: hash("k", index), signature: hash("s", index), request: request(), state: "failed",
      requestedAt: timestamp, updatedAt: timestamp, error: { code: "e", retryable: false },
    });
  }
  const document = { schemaVersion: 2, records, retirements: [], retirementCleanups: [] };
  const targetBytes = 1_000_000 - 200;
  let padding = targetBytes - Buffer.byteLength(`${JSON.stringify(document)}\n`);
  for (const record of records.slice(1)) {
    for (const [object, field] of [
      [record.request, "provider"], [record.request, "target"], [record.request, "profile"],
      [record.request, "mode"], [record.request, "capabilityVersion"], [record.error, "code"],
    ]) {
      const added = Math.min(99, padding);
      object[field] += "x".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    if (padding === 0) break;
  }
  assert.equal(padding, 0);
  const content = `${JSON.stringify(document)}\n`;
  assert.equal(Buffer.byteLength(content), targetBytes);
  await writeFile(ledgerFile, content, { mode: 0o600 });

  const ledger = new LaunchLedger(ledgerFile);
  await ledger.open();
  await assert.rejects(
    ledger.beginRetirement(owned.id, "r".repeat(43)),
    /cannot reserve retirement completion capacity/,
  );
  assert.equal(ledger.get(owned.id).state, "owned");
  await ledger.close();
});

test("provider retirement capacity is reserved before the launch ledger fence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-provider-retirement-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const registry = fixtureRegistry();
  let retireCalls = 0;
  registry.prepareLaunchRetirement = async () => ({
    status: "blocked", code: "cursor_provenance_capacity",
  });
  registry.retireLaunch = async () => { retireCalls += 1; return { status: "retired" }; };
  const coordinator = new LaunchCoordinator(registry, { ledgerFile });
  await coordinator.start();
  t.after(() => coordinator.stop());
  const accepted = await coordinator.submit(LOCAL_REQUEST, "capacity-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  await waitFor(async () => (
    JSON.parse(await readFile(ledgerFile, "utf8")).records[0].state === "owned"
  ));
  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "capacity-retirement-key",
    ),
    (error) => error.code === "launch_retirement_capacity" && error.status === 503,
  );
  assert.equal(coordinator.get(accepted.launch.id).state, "owned");
  assert.equal(retireCalls, 0);
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).records[0].state, "owned");
});

test("a losing ledger key race releases the provider retirement reservation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-key-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const durableLedger = new LaunchLedger(join(directory, "launches.json"));
  const ledger = new Proxy(durableLedger, {
    get(target, property) {
      if (property === "beginRetirement") {
        return async () => {
          const error = new Error("retirement key already claimed");
          error.code = "retirement_key_conflict";
          throw error;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let released;
  const registry = fixtureRegistry();
  registry.prepareLaunchRetirement = async () => ({ status: "prepared" });
  registry.cancelLaunchRetirementPreparation = async (provider, record, options) => {
    released = { provider, record, options };
    return true;
  };
  const coordinator = new LaunchCoordinator(registry, { ledger });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "racing-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");

  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "racing-retirement-key",
    ),
    (error) => error.code === "idempotency_conflict",
  );
  assert.equal(released.provider, "demo");
  assert.equal(released.record.id, accepted.launch.id);
  assert.match(released.options.keyHash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(released.options.signal.aborted, false);
  assert.equal(coordinator.get(accepted.launch.id).state, "owned");
  await coordinator.stop();
});

test("a pre-fence ledger capacity failure releases the provider retirement reservation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-ledger-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const durableLedger = new LaunchLedger(join(directory, "launches.json"));
  const ledger = new Proxy(durableLedger, {
    get(target, property) {
      if (property === "beginRetirement") {
        return async () => { throw new Error("launch ledger cannot reserve retirement completion capacity"); };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let releases = 0;
  const registry = fixtureRegistry();
  registry.prepareLaunchRetirement = async () => ({ status: "prepared" });
  registry.cancelLaunchRetirementPreparation = async () => { releases += 1; return true; };
  const coordinator = new LaunchCoordinator(registry, { ledger });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "ledger-capacity-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");

  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "ledger-capacity-retirement-key",
    ),
    /cannot reserve retirement completion capacity/,
  );
  assert.equal(releases, 1);
  assert.equal(coordinator.get(accepted.launch.id).state, "owned");
  await coordinator.stop();
});

test("timed-out retirement preparation is capped until its provider settles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-preparation-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let preparationSignal;
  let preparationCalls = 0;
  let preparationSettled = false;
  let deactivated;
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  const registry = fixtureRegistry();
  registry.prepareLaunchRetirement = async (_provider, _record, { signal }) => {
    preparationCalls += 1;
    preparationSignal = signal;
    if (preparationCalls === 1) {
      await preparationGate;
      preparationSettled = true;
    }
    return { status: "prepared" };
  };
  registry.retireLaunch = async () => ({ status: "retired" });
  registry.deactivateOwnedLaunch = (id) => { deactivated = id; };
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"),
    launchTimeoutMs: 10,
  });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "preparation-timeout-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");

  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "preparation-timeout-retirement-key",
    ),
    (error) => error.code === "launch_retirement_uncertain",
  );
  assert.equal(preparationSignal.aborted, true);
  assert.equal(coordinator.get(accepted.launch.id).state, "retiring");
  assert.equal(deactivated, accepted.launch.id);
  const fenced = JSON.parse(await readFile(join(directory, "launches.json"), "utf8")).records[0];
  assert.match(fenced.retirementKeyHash, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "preparation-timeout-retirement-key",
    ),
    (error) => error.code === "launch_retirement_uncertain",
  );
  assert.equal(preparationCalls, 1);

  const next = await coordinator.submit(LOCAL_REQUEST, "post-preparation-timeout-launch-key");
  await waitFor(() => coordinator.get(next.launch.id)?.state === "owned");
  await assert.rejects(
    coordinator.retire(
      next.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "blocked-by-pending-preparation-key",
    ),
    (error) => error.code === "launch_retirement_uncertain",
  );
  assert.equal(preparationCalls, 1);

  releasePreparation();
  await waitFor(() => preparationSettled);
  await Promise.resolve();
  const retired = await coordinator.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "preparation-timeout-retirement-key",
  );
  assert.equal(retired.retirement.state, "retired");
  assert.equal(preparationCalls, 1);
  await coordinator.stop();
});

test("a late blocked retirement preparation restores the fenced owned launch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-preparation-late-blocked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  let deactivated;
  let reactivated;
  const registry = fixtureRegistry();
  registry.prepareLaunchRetirement = async () => {
    await preparationGate;
    return { status: "blocked", code: "cursor_provenance_capacity" };
  };
  registry.deactivateOwnedLaunch = (id) => {
    deactivated = id;
    return { id: "cached-agent" };
  };
  registry.activateOwnedLaunch = (record, cachedAgent) => {
    reactivated = { record, cachedAgent };
  };
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"),
    launchTimeoutMs: 10,
  });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "late-blocked-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");

  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "late-blocked-retirement-key",
    ),
    (error) => error.code === "launch_retirement_uncertain",
  );
  assert.equal(coordinator.get(accepted.launch.id).state, "retiring");
  assert.equal(deactivated, accepted.launch.id);
  releasePreparation();
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned"
    && reactivated?.cachedAgent?.id === "cached-agent");
  assert.equal(reactivated.record.id, accepted.launch.id);
  assert.deepEqual(reactivated.cachedAgent, { id: "cached-agent" });
  await coordinator.stop();
});

test("launch ledger rejects duplicate retirement keys during recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-duplicate-retirement-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const timestamp = "2026-08-25T00:00:00.000Z";
  const record = (index, keyHash, signature) => ({
    id: `launch:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    attemptId: `attempt:10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    keyHash,
    signature,
    request: resolvedRequest(),
    state: "retiring",
    requestedAt: timestamp,
    updatedAt: timestamp,
    providerAgentId: `provider:${index}`,
    agentId: `demo:owned:${index}`,
    retirementKeyHash: "r".repeat(43),
  });
  await writeFile(ledgerFile, `${JSON.stringify({
    schemaVersion: 2,
    records: [record(1, "a".repeat(43), "b".repeat(43)), record(2, "c".repeat(43), "d".repeat(43))],
    retirements: [],
    retirementCleanups: [],
  })}\n`, { mode: 0o600 });

  const ledger = new LaunchLedger(ledgerFile);
  await assert.rejects(ledger.open(), /duplicate records or idempotency keys/);
});

test("retirement capacity reserves the largest tombstones across completion orders", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-order-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const timestamp = "2026-08-25T00:00:00.000Z";
  const identity = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const hash = (prefix, index) => `${prefix}${index.toString(36).padStart(42, "0")}`;
  const request = (size) => ({
    provider: "p".repeat(size), target: "t".repeat(size), profile: "p".repeat(size),
    mode: "m".repeat(size), capabilityVersion: "v".repeat(size),
    risk: { localMutation: true, externalBillable: false },
  });
  const retiring = Array.from({ length: 101 }, (_, index) => ({
    id: `launch:${identity(index)}`, attemptId: `attempt:${identity(index)}`,
    keyHash: hash("k", index), signature: hash("s", index),
    request: request(index === 0 ? 100 : 1), state: "retiring",
    requestedAt: timestamp, updatedAt: timestamp, providerAgentId: "provider", agentId: "agent",
    retirementKeyHash: hash("r", index),
  }));
  const fillers = Array.from({ length: 899 }, (_, offset) => {
    const index = offset + retiring.length;
    return {
      id: `launch:${identity(index)}`, attemptId: `attempt:${identity(index)}`,
      keyHash: hash("k", index), signature: hash("s", index), request: request(1), state: "failed",
      requestedAt: timestamp, updatedAt: timestamp, error: { code: "e", retryable: false },
    };
  });
  const tombstone = (record) => ({
    launchId: record.id, attemptId: record.attemptId, provider: record.request.provider,
    keyHash: record.retirementKeyHash, creationKeyHash: record.keyHash, signature: record.signature,
    request: record.request, requestedAt: record.requestedAt, retiredAt: record.updatedAt,
    cleanupScope: "x".repeat(16),
  });
  const cleanup = (entry) => ({
    launchId: entry.launchId, attemptId: entry.attemptId, provider: entry.provider, keyHash: entry.keyHash,
    cleanupScope: entry.cleanupScope,
  });
  const tombstones = retiring.map(tombstone);
  const cleanups = tombstones.map(cleanup);
  const projected = (retirements) => ({
    schemaVersion: 2, records: fillers, retirements, retirementCleanups: cleanups,
  });
  const assumed = projected(tombstones.slice(1));
  const targetBytes = 1_000_000 - 100;
  let padding = targetBytes - Buffer.byteLength(`${JSON.stringify(assumed)}\n`);
  for (const record of fillers) {
    for (const [object, field] of [
      [record.request, "provider"], [record.request, "target"], [record.request, "profile"],
      [record.request, "mode"], [record.request, "capabilityVersion"], [record.error, "code"],
    ]) {
      const added = Math.min(99, padding);
      object[field] += "x".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    if (padding === 0) break;
  }
  assert.equal(padding, 0);
  assert.equal(Buffer.byteLength(`${JSON.stringify(assumed)}\n`), targetBytes);
  assert.ok(Buffer.byteLength(`${JSON.stringify(projected([
    tombstones[0], ...tombstones.slice(1, 100),
  ]))}\n`) > 1_000_000);
  const content = `${JSON.stringify({
    schemaVersion: 2, records: [...retiring, ...fillers], retirements: [], retirementCleanups: [],
  })}\n`;
  assert.ok(Buffer.byteLength(content) <= 1_000_000);
  await writeFile(ledgerFile, content, { mode: 0o600 });

  const ledger = new LaunchLedger(ledgerFile);
  await ledger.open();
  await assert.rejects(
    ledger.transition(fillers[0].id, ["failed"], {}, timestamp),
    /cannot reserve retirement completion capacity/,
  );
  await ledger.close();
});

test("full legacy ledgers migrate without expanding their serialized size", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-legacy-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const timestamp = "2026-08-25T00:00:00.000Z";
  const identity = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const hash = (prefix, index) => `${prefix}${index.toString(36).padStart(42, "0")}`;
  const records = Array.from({ length: 1_000 }, (_, index) => ({
    id: `launch:${identity(index)}`, attemptId: `attempt:${identity(index)}`,
    keyHash: hash("k", index), signature: hash("s", index),
    request: {
      provider: "p", target: "t", profile: "p", mode: "m", capabilityVersion: "v",
      risk: { localMutation: true, externalBillable: false },
    },
    state: "failed", requestedAt: timestamp, updatedAt: timestamp,
    error: { code: "e", retryable: false },
  }));
  records[0].state = "requested";
  delete records[0].error;
  const document = { schemaVersion: 1, records };
  const targetBytes = 999_990;
  let padding = targetBytes - Buffer.byteLength(`${JSON.stringify(document)}\n`);
  for (const record of records) {
    for (const [object, field] of [
      [record.request, "provider"], [record.request, "target"], [record.request, "profile"],
      [record.request, "mode"], [record.request, "capabilityVersion"],
      ...(record.error ? [[record.error, "code"]] : []),
    ]) {
      const added = Math.min(99, padding);
      object[field] += "x".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    if (padding === 0) break;
  }
  assert.equal(padding, 0);
  const content = `${JSON.stringify(document)}\n`;
  assert.equal(Buffer.byteLength(content), targetBytes);
  await writeFile(ledgerFile, content, { mode: 0o600 });

  const first = new LaunchLedger(ledgerFile);
  assert.equal((await first.open()).length, 1_000);
  await first.close();
  const migrated = await readFile(ledgerFile, "utf8");
  assert.equal(Buffer.byteLength(migrated), targetBytes);
  const parsed = JSON.parse(migrated);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.retirements, undefined);
  assert.equal(parsed.retirementCleanups, undefined);

  const reopened = new LaunchLedger(ledgerFile);
  assert.equal((await reopened.open()).length, 1_000);
  await reopened.transition(records[0].id, ["requested"], { state: "creating" });
  await reopened.close();
  const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(persisted.records[0].state, "creating");
  assert.equal(persisted.retirements, undefined);
  assert.equal(persisted.retirementCleanups, undefined);
});

test("full v2 ledgers derive legacy cleanup work without expanding on open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-v2-cleanup-capacity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const timestamp = "2026-08-25T00:00:00.000Z";
  const identity = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const hash = (prefix, index) => `${prefix}${index.toString(36).padStart(42, "0")}`;
  const request = {
    provider: "p", target: "t", profile: "p", mode: "m", capabilityVersion: "v",
    risk: { localMutation: true, externalBillable: false },
  };
  const records = Array.from({ length: 1_000 }, (_, index) => ({
    id: `launch:${identity(index)}`, attemptId: `attempt:${identity(index)}`,
    keyHash: hash("k", index), signature: hash("s", index), request: { ...request },
    state: "failed", requestedAt: timestamp, updatedAt: timestamp,
    error: { code: "e", retryable: false },
  }));
  const retirement = {
    launchId: `launch:${identity(1_001)}`, attemptId: `attempt:${identity(1_001)}`,
    provider: "p", keyHash: hash("r", 1_001), creationKeyHash: hash("k", 1_001),
    signature: hash("s", 1_001), request: { ...request }, requestedAt: timestamp,
    retiredAt: timestamp, cleanupScope: "cursor_scope_001",
  };
  const document = { schemaVersion: 2, records, retirements: [retirement] };
  const targetBytes = 999_990;
  let padding = targetBytes - Buffer.byteLength(`${JSON.stringify(document)}\n`);
  for (const record of records) {
    for (const [object, field] of [
      [record.request, "provider"], [record.request, "target"], [record.request, "profile"],
      [record.request, "mode"], [record.request, "capabilityVersion"], [record.error, "code"],
    ]) {
      const added = Math.min(99, padding);
      object[field] += "x".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    if (padding === 0) break;
  }
  assert.equal(padding, 0);
  const content = `${JSON.stringify(document)}\n`;
  assert.equal(Buffer.byteLength(content), targetBytes);
  await writeFile(ledgerFile, content, { mode: 0o600 });

  const ledger = new LaunchLedger(ledgerFile);
  assert.equal((await ledger.open()).length, 1_000);
  assert.deepEqual(ledger.retirementCleanups(), [{
    launchId: retirement.launchId,
    attemptId: retirement.attemptId,
    provider: retirement.provider,
    keyHash: retirement.keyHash,
    cleanupScope: retirement.cleanupScope,
  }]);
  await ledger.close();
  assert.equal(await readFile(ledgerFile, "utf8"), content);
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

  let unsupportedCalls = 0;
  const disabledRegistry = fixtureRegistry();
  disabledRegistry.retireLaunch = async () => {
    unsupportedCalls += 1;
    return { status: "unsupported" };
  };
  disabledRegistry.deactivateOwnedLaunch = () => {};
  const disabled = new LaunchCoordinator(disabledRegistry, { ledgerFile });
  await disabled.start();
  await waitFor(() => unsupportedCalls === 1);
  assert.equal(disabled.get(accepted.launch.id).state, "retiring");
  await disabled.stop();

  let resumed = 0;
  let finalized;
  const secondRegistry = fixtureRegistry();
  secondRegistry.retireLaunch = async (_provider, record) => {
    resumed += 1;
    assert.equal(record.state, "retiring");
    return { status: "retired", cleanupScope: "demo_scope_00001" };
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

test("startup recovers provider-only retirement reservations before accepting launches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-preparation-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const first = new LaunchCoordinator(fixtureRegistry(), { ledgerFile });
  await first.start();
  const accepted = await first.submit(LOCAL_REQUEST, "preparation-recovery-launch-key");
  await waitFor(() => first.get(accepted.launch.id)?.state === "owned");
  await first.stop();
  await waitFor(async () => {
    try { await lstat(`${ledgerFile}.writer.lock`); return false; }
    catch (error) { return error?.code === "ENOENT"; }
  });

  let recover;
  const recoveryGate = new Promise((resolve) => { recover = resolve; });
  let recovered;
  const registry = fixtureRegistry();
  registry.recoverLaunchRetirementPreparations = async (records) => {
    recovered = records;
    await recoveryGate;
    return true;
  };
  const second = new LaunchCoordinator(registry, { ledgerFile });
  t.after(() => second.stop());
  const starting = second.start();
  await waitFor(() => recovered?.length === 1);
  await assert.rejects(
    second.submit(LOCAL_REQUEST, "must-not-be-claimed-before-recovery"),
    (error) => error.code === "launch_unavailable" && error.status === 503,
  );
  recover();
  await starting;
  assert.equal(recovered[0].id, accepted.launch.id);
  assert.equal(second.get(accepted.launch.id).state, "owned");
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

test("timed-out retirement work remains single-flight until the provider settles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releaseFirst;
  const firstProvider = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => {
    calls += 1;
    if (calls === 1) await firstProvider;
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"),
    launchTimeoutMs: 20,
  });
  await coordinator.start();
  t.after(() => coordinator.stop());
  const accepted = await coordinator.submit(LOCAL_REQUEST, "timeout-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  await assert.rejects(
    coordinator.retire(accepted.launch.id, confirmation, "timeout-retirement-key"),
    (error) => error.code === "launch_retirement_uncertain",
  );
  await assert.rejects(
    coordinator.retire(accepted.launch.id, confirmation, "timeout-retirement-key"),
    (error) => error.code === "launch_retirement_uncertain",
  );
  assert.equal(calls, 1);

  releaseFirst();
  let replay;
  await waitFor(async () => {
    try {
      replay = await coordinator.retire(
        accepted.launch.id, confirmation, "timeout-retirement-key",
      );
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(calls, 2);
  assert.equal(replay.replayed, true);
  assert.equal(replay.retirement.state, "retired");
});

test("retirement work is bounded globally and per provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = fixtureRegistry();
  const capability = new DemoLaunchAdapter().launchCapabilities();
  registry.launchCapabilities = () => Array.from({ length: 5 }, (_, index) => ({
    ...capability, provider: `provider-${index}`,
  }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maximumActive = 0;
  const activeByProvider = new Map();
  let maximumPerProvider = 0;
  let calls = 0;
  registry.retireLaunch = async (provider) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const providerActive = (activeByProvider.get(provider) ?? 0) + 1;
    activeByProvider.set(provider, providerActive);
    maximumPerProvider = Math.max(maximumPerProvider, providerActive);
    await gate;
    active -= 1;
    activeByProvider.set(provider, providerActive - 1);
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"),
  });
  await coordinator.start();
  t.after(() => coordinator.stop());
  const providers = ["provider-0", "provider-0", "provider-1", "provider-2", "provider-3", "provider-4"];
  const accepted = await Promise.all(providers.map((provider, index) => coordinator.submit({
    ...LOCAL_REQUEST, provider,
  }, `bounded-launch-${index}`)));
  await Promise.all(accepted.map(({ launch }) => waitFor(
    () => coordinator.get(launch.id)?.state === "owned",
  )));
  const confirmation = { confirmDeleteOwnedAgentAndState: true };
  const retirements = accepted.map(({ launch }, index) => coordinator.retire(
    launch.id, confirmation, `bounded-retirement-${index}`,
  ));
  await waitFor(() => calls === 4);
  assert.equal(maximumActive, 4);
  assert.equal(maximumPerProvider, 1);
  release();
  await Promise.all(retirements);
  assert.equal(calls, providers.length);
  assert.equal(maximumActive, 4);
  assert.equal(maximumPerProvider, 1);
});

test("launch and retirement work share global and provider admission limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-mixed-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = fixtureRegistry();
  const capability = new DemoLaunchAdapter().launchCapabilities();
  registry.launchCapabilities = () => Array.from({ length: 5 }, (_, index) => ({
    ...capability, provider: `provider-${index}`,
  }));
  const coordinator = new LaunchCoordinator(registry, {
    ledgerFile: join(directory, "launches.json"),
  });
  await coordinator.start();
  t.after(() => coordinator.stop());
  const retiringTarget = await coordinator.submit({
    ...LOCAL_REQUEST, provider: "provider-0",
  }, "mixed-retiring-target");
  await waitFor(() => coordinator.get(retiringTarget.launch.id)?.state === "owned");

  let releaseLaunches;
  const launchGate = new Promise((resolve) => { releaseLaunches = resolve; });
  let active = 0;
  let maximumActive = 0;
  const activeByProvider = new Map();
  let maximumPerProvider = 0;
  let launchCalls = 0;
  let retirementCalls = 0;
  const enter = (provider) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const providerActive = (activeByProvider.get(provider) ?? 0) + 1;
    activeByProvider.set(provider, providerActive);
    maximumPerProvider = Math.max(maximumPerProvider, providerActive);
  };
  const leave = (provider) => {
    active -= 1;
    activeByProvider.set(provider, (activeByProvider.get(provider) ?? 1) - 1);
  };
  registry.launch = async (provider, record) => {
    launchCalls += 1;
    enter(provider);
    await launchGate;
    leave(provider);
    return ownedResult(record);
  };
  registry.retireLaunch = async (provider) => {
    retirementCalls += 1;
    enter(provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    leave(provider);
    return { status: "retired" };
  };
  registry.deactivateOwnedLaunch = () => {};

  const launches = ["provider-0", "provider-1", "provider-2", "provider-3"].map(
    (provider, index) => coordinator.submit({ ...LOCAL_REQUEST, provider }, `mixed-launch-${index}`),
  );
  await waitFor(() => launchCalls === 4);
  const retirement = coordinator.retire(
    retiringTarget.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "mixed-retirement",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(retirementCalls, 0);
  assert.equal(maximumActive, 4);
  assert.equal(maximumPerProvider, 1);

  releaseLaunches();
  await Promise.all([...launches, retirement]);
  assert.equal(retirementCalls, 1);
  assert.equal(maximumActive, 4);
  assert.equal(maximumPerProvider, 1);
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

test("shutdown tracks retirement before its durable fence completes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-fence-shutdown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const durableLedger = new LaunchLedger(ledgerFile);
  let releaseFence;
  const fenceGate = new Promise((resolve) => { releaseFence = resolve; });
  let fenceStarted = false;
  const ledger = new Proxy(durableLedger, {
    get(target, property) {
      if (property === "beginRetirement") {
        return async (...args) => {
          fenceStarted = true;
          await fenceGate;
          return target.beginRetirement(...args);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let retireCalls = 0;
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => { retireCalls += 1; return { status: "retired" }; };
  const coordinator = new LaunchCoordinator(registry, { ledger });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "fence-shutdown-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  const retirement = coordinator.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "fence-shutdown-retirement-key",
  );
  const retirementOutcome = retirement.then(
    () => undefined,
    (error) => error,
  );
  await waitFor(() => fenceStarted);
  const stopping = coordinator.stop();
  releaseFence();
  assert.equal((await retirementOutcome).code, "shutting_down");
  await stopping;
  assert.equal(retireCalls, 0);
  const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(persisted.records[0].state, "retiring");
});

test("retirement cleanup survives replay-tombstone eviction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-launch-retirement-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const cleanupScope = "cursor_scope_001";
  const firstRegistry = fixtureRegistry();
  firstRegistry.retireLaunch = async () => ({ status: "retired", cleanupScope });
  firstRegistry.deactivateOwnedLaunch = () => {};
  firstRegistry.finalizeLaunchRetirement = async () => false;
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
  assert.equal(persisted.retirementCleanups[0].cleanupScope, cleanupScope);
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
  await waitFor(() => cleanup?.launchId === accepted.launch.id);
  assert.equal(cleanup.launchId, accepted.launch.id);
  assert.equal(cleanup.cleanupScope, cleanupScope);
  await second.stop();
  const cleaned = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(cleaned.retirementCleanups, undefined);
});

test("timed-out provider cleanup leaves durable work without blocking retirement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-cleanup-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  let cleanupSignal;
  let releaseCleanup;
  let lateCleanupSettled = false;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => ({ status: "retired", cleanupScope: "cursor_scope_001" });
  registry.deactivateOwnedLaunch = () => {};
  registry.finalizeLaunchRetirement = async (_entry, { signal }) => {
    cleanupSignal = signal;
    await cleanupGate;
    lateCleanupSettled = true;
    return true;
  };
  const coordinator = new LaunchCoordinator(registry, { ledgerFile, launchTimeoutMs: 10 });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "cleanup-timeout-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");

  const result = await coordinator.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "cleanup-timeout-retirement-key",
  );
  assert.equal(result.retirement.state, "retired");
  await waitFor(() => cleanupSignal?.aborted === true);
  await coordinator.stop();
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).retirementCleanups.length, 1);
  releaseCleanup();
  await waitFor(() => lateCleanupSettled);

  let recoveryCalls = 0;
  const recoveryRegistry = fixtureRegistry();
  recoveryRegistry.finalizeLaunchRetirement = async () => { recoveryCalls += 1; return true; };
  const recovery = new LaunchCoordinator(recoveryRegistry, { ledgerFile, launchTimeoutMs: 10 });
  await Promise.race([
    recovery.start(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup recovery blocked startup")), 100)),
  ]);
  await waitFor(() => recoveryCalls === 1);
  await recovery.stop();
  assert.deepEqual(JSON.parse(await readFile(ledgerFile, "utf8")).retirementCleanups, []);
});

test("multiple hung retirement cleanups cannot multiply startup delay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-retirement-cleanup-startup-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const retirementCleanups = Array.from({ length: 3 }, (_, index) => ({
    launchId: `launch:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    attemptId: `attempt:10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    provider: "demo",
    keyHash: `${index}${"r".repeat(42)}`,
    cleanupScope: "cursor_scope_001",
  }));
  await writeFile(ledgerFile, `${JSON.stringify({
    schemaVersion: 2, records: [], retirements: [], retirementCleanups,
  })}\n`, { mode: 0o600 });
  let cleanupCalls = 0;
  const registry = fixtureRegistry();
  registry.finalizeLaunchRetirement = async () => {
    cleanupCalls += 1;
    await new Promise(() => {});
  };
  const coordinator = new LaunchCoordinator(registry, { ledgerFile, launchTimeoutMs: 1_000 });
  await Promise.race([
    coordinator.start(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup recovery blocked startup")), 500)),
  ]);
  await waitFor(() => cleanupCalls === 1);
  await coordinator.stop();
  assert.equal(cleanupCalls, 1);
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).retirementCleanups.length, 3);
});

test("retirement without a provider cleanup scope does not retain cleanup work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-no-retirement-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "launches.json");
  const registry = fixtureRegistry();
  registry.retireLaunch = async () => ({ status: "retired" });
  registry.deactivateOwnedLaunch = () => {};
  const coordinator = new LaunchCoordinator(registry, { ledgerFile });
  await coordinator.start();
  const accepted = await coordinator.submit(LOCAL_REQUEST, "no-cleanup-launch-key");
  await waitFor(() => coordinator.get(accepted.launch.id)?.state === "owned");
  await coordinator.retire(
    accepted.launch.id,
    { confirmDeleteOwnedAgentAndState: true },
    "no-cleanup-retirement-key",
  );
  await coordinator.stop();

  const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(persisted.retirements.length, 1);
  assert.deepEqual(persisted.retirementCleanups, []);
});

test("a new pre-delete retirement refusal restores owned launch state", async (t) => {
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
  registry.retireLaunch = async () => ({ status: "unsupported" });
  await assert.rejects(
    coordinator.retire(
      accepted.launch.id,
      { confirmDeleteOwnedAgentAndState: true },
      "unsupported-retirement-key",
    ),
    (error) => error.code === "launch_not_retirable" && error.status === 409,
  );
  assert.equal(coordinator.get(accepted.launch.id).state, "owned");
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

  const unscopedCleanup = join(directory, "unscoped-cleanup.json");
  await writeFile(unscopedCleanup, `${JSON.stringify({
    schemaVersion: 2,
    records: [],
    retirements: [],
    retirementCleanups: [{
      launchId: "launch:00000000-0000-4000-8000-000000000000",
      attemptId: "attempt:00000000-0000-4000-8000-000000000001",
      provider: "cursor",
      keyHash: "c".repeat(43),
    }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(new LaunchLedger(unscopedCleanup).open(), /unsupported or malformed/);

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
