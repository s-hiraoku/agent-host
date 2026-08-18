import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorSdkAdapter, createCursorSdkCredentialSource } from "../src/adapters/cursor-sdk.js";
import { AgentRegistry } from "../src/core/registry.js";
import { LaunchCoordinator } from "../src/core/launch-coordinator.js";
import { noCapabilities } from "../src/core/types.js";
import { readPrivateFileBounded, writePrivateFileAtomic } from "../src/secure-state.js";
import { acquireInstanceLock } from "../src/instance-lock.js";

const ATTEMPT_ID = "attempt:00000000-0000-4000-8000-000000000001";
const LAUNCH_ID = "launch:00000000-0000-4000-8000-000000000002";

test("Cursor SDK adapter is explicit-injection only and advertises both local risks", async (t) => {
  const fixture = await makeFixture(t);
  assert.deepEqual(fixture.adapter.launchCapabilities(), {
    provider: "cursor",
    capabilityVersion: "cursor-sdk-local-1.0.28",
    targets: [{ id: "workspace-a", profiles: ["safe"], modes: [
      { id: "local", enabled: true, localMutation: true, externalBillable: true },
    ] }],
  });
  assert.deepEqual(await fixture.adapter.discover(), []);
});

test("Cursor SDK credential sources are explicit, bounded, and opaque to serialization", async () => {
  for (const value of [undefined, null, {}, [], "", "short", "x".repeat(16_385)]) {
    assert.throws(
      () => createCursorSdkCredentialSource(value),
      /explicit secret or secret callback|invalid credential/,
    );
  }
  const secret = "cursor-fixture-secret";
  const source = createCursorSdkCredentialSource(secret);
  assert.equal(JSON.stringify(source), "{}");
  assert.equal(JSON.stringify({ credentialSource: source }).includes(secret), false);
});

test("Cursor SDK adapter rejects absent or unbranded credential sources", async (t) => {
  const fixture = await makeFixture(t);
  const options = {
    bridge: { ...fixture.bridge, namespace: "credential-validation" },
    sdkVersion: "1.0.28",
    storeDirectory: fixture.storeDirectory,
    provenanceFile: fixture.provenanceFile,
    targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  };
  assert.throws(
    () => new CursorSdkAdapter(options),
    /explicitly injected credential source/,
  );
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: { secret: "cursor-fixture-secret" } }),
    /explicitly injected credential source/,
  );
  const source = fixtureCredentialSource();
  const assigned = new CursorSdkAdapter({ ...options, credentialSource: source });
  t.after(() => assigned.close());
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: source }),
    /already assigned to an adapter/,
  );
});

test("Cursor SDK supplies credentials transiently and redacts bridge results", async (t) => {
  const secret = "cursor-fixture-secret";
  let observedCredential;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      observedCredential = input.credential;
      assert.ok(Buffer.isBuffer(input.credential));
      assert.equal(input.credential.toString("utf8"), secret);
      return { agentId: input.agentId, name: `created with ${secret}` };
    },
    async getLocal({ agentId, credential }) {
      observedCredential = credential;
      assert.equal(credential.toString("utf8"), secret);
      return { agentId, status: "idle", name: `owned with ${secret}` };
    },
  }, { credentialSource: createCursorSdkCredentialSource(secret) });

  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  const agents = await fixture.adapter.discoverOwned([ledgerRecord(owned)]);
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  assert.equal(JSON.stringify(agents).includes(secret), false);
  assert.equal(agents[0].name, "owned with [REDACTED]");
  assert.equal((await readFile(fixture.provenanceFile, "utf8")).includes(secret), false);
  assert.equal(JSON.stringify(owned).includes(secret), false);
});

test("Cursor SDK redacts accepted multibyte credentials shorter than eight characters", async (t) => {
  const secret = "\u79d8\u5bc6\u9375";
  assert.ok(Buffer.byteLength(secret, "utf8") >= 8);
  assert.ok(secret.length < 8);
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      return { agentId: input.agentId, name: `created with ${secret}` };
    },
    async getLocal({ agentId }) {
      return { agentId, status: "idle", name: `owned with ${secret}` };
    },
  }, { credentialSource: createCursorSdkCredentialSource(secret) });

  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const agents = await fixture.adapter.discoverOwned([ledgerRecord(owned)]);
  assert.equal(agents[0].name, "owned with [REDACTED]");
  assert.equal(JSON.stringify(agents).includes(secret), false);
});

test("Cursor SDK redacts creation, reconciliation, discovery, and cancellation failures", async (t) => {
  const secret = "cursor-fixture-secret";
  let observedCredential;
  const failed = await makeFixture(t, {
    async createLocal({ credential }) {
      observedCredential = credential;
      throw new Error(`provider rejected ${secret}`);
    },
    async getLocal({ credential }) {
      observedCredential = credential;
      throw new Error(`provider rejected ${secret}`);
    },
  }, { credentialSource: createCursorSdkCredentialSource(() => secret) });
  await assert.rejects(
    failed.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    (error) => error.code === "cursor_bridge_failed"
      && error.message === "Cursor SDK bridge createLocal failed"
      && !JSON.stringify(error).includes(secret),
  );
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  await assert.rejects(
    failed.adapter.reconcileLaunch({ id: LAUNCH_ID, attemptId: ATTEMPT_ID, request: resolvedRequest() }),
    (error) => error.code === "cursor_bridge_failed"
      && error.message === "Cursor SDK bridge getLocal failed"
      && !JSON.stringify(error).includes(secret),
  );
  assert.equal(observedCredential.every((byte) => byte === 0), true);

  const owned = await makeFixture(t, {}, { credentialSource: createCursorSdkCredentialSource(secret) });
  const launched = await owned.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  owned.bridge.getLocal = async ({ credential }) => {
    observedCredential = credential;
    throw new Error(secret);
  };
  await assert.rejects(
    owned.adapter.discoverOwned([ledgerRecord(launched)]),
    (error) => error.code === "cursor_bridge_failed" && !error.message.includes(secret),
  );
  assert.equal(observedCredential.every((byte) => byte === 0), true);

  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(
    owned.adapter.reconcileLaunch(ledgerRecord(launched), { signal: controller.signal }),
    (error) => error.code === "cursor_operation_cancelled" && !error.message.includes(secret),
  );
});

test("Cursor SDK masks credential callback failures without fallback", async (t) => {
  const secret = "cursor-fixture-secret";
  const fixture = await makeFixture(t, {}, {
    credentialSource: createCursorSdkCredentialSource(() => { throw new Error(secret); }),
  });
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    (error) => error.code === "cursor_credential_unavailable"
      && error.message === "Cursor SDK credential source is unavailable"
      && !error.message.includes(secret),
  );
  assert.equal((await readFile(fixture.provenanceFile, "utf8")).includes(secret), false);
});

test("Cursor SDK rejects spoofed public credential error codes", async (t) => {
  const secret = "cursor-fixture-secret";
  for (const code of [
    "cursor_credential_invalid",
    "cursor_credential_unavailable",
    "cursor_operation_cancelled",
  ]) {
    const callbackError = new Error(`callback leaked ${secret}`);
    callbackError.code = code;
    const callbackFixture = await makeFixture(t, {}, {
      credentialSource: createCursorSdkCredentialSource(() => { throw callbackError; }),
    });
    await assert.rejects(
      callbackFixture.adapter.launch(resolvedRequest(), {
        attemptId: `attempt:${uuidFor(910 + code.length)}`,
        launchId: `launch:${uuidFor(910 + code.length)}`,
      }),
      (error) => error.code === "cursor_credential_unavailable"
        && error.message === "Cursor SDK credential source is unavailable"
        && !error.message.includes(secret),
    );

    const bridgeError = new Error(`bridge leaked ${secret}`);
    bridgeError.code = code;
    const bridgeFixture = await makeFixture(t, {
      async createLocal() { throw bridgeError; },
    }, { credentialSource: createCursorSdkCredentialSource(secret) });
    await assert.rejects(
      bridgeFixture.adapter.launch(resolvedRequest(), {
        attemptId: `attempt:${uuidFor(920 + code.length)}`,
        launchId: `launch:${uuidFor(920 + code.length)}`,
      }),
      (error) => error.code === "cursor_bridge_failed"
        && error.message === "Cursor SDK bridge createLocal failed"
        && !error.message.includes(secret),
    );
  }
});

test("Cursor SDK close is reopenable and destroy is terminal", async (t) => {
  const secret = "cursor-fixture-secret";
  let observedCredential;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      observedCredential = input.credential;
      const agent = { agentId: input.agentId, status: "idle" };
      fixture.agents.set(input.agentId, agent);
      return agent;
    },
    async getLocal({ agentId, credential }) {
      observedCredential = credential;
      return fixture.agents.get(agentId) ?? null;
    },
  }, { credentialSource: createCursorSdkCredentialSource(secret) });

  await fixture.adapter.close();
  assert.equal(fixture.adapter.launchCapabilities(), null);
  await fixture.adapter.open();
  assert.ok(fixture.adapter.launchCapabilities());
  const attemptId = `attempt:${uuidFor(901)}`;
  const launchId = `launch:${uuidFor(901)}`;
  const launched = await fixture.adapter.launch(resolvedRequest(), { attemptId, launchId });
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  assert.deepEqual(await fixture.adapter.reconcileLaunch({
    id: launchId,
    attemptId,
    state: "owned",
    agentId: launched.agentId,
    providerAgentId: launched.providerAgentId,
    request: resolvedRequest(),
  }), launched);
  assert.equal(observedCredential.every((byte) => byte === 0), true);

  await fixture.adapter.destroy();
  await fixture.adapter.destroy();
  assert.equal(fixture.adapter.launchCapabilities(), null);
  await assert.rejects(fixture.adapter.open(), /adapter is destroyed/);
});

test("Cursor SDK concurrent destroy callers share the in-flight destruction", async (t) => {
  let finishCreate;
  const createBlocked = new Promise((resolve) => { finishCreate = resolve; });
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      await createBlocked;
      return { agentId: input.agentId, status: "idle" };
    },
  });
  const launch = fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  await new Promise((resolve) => setImmediate(resolve));

  const first = fixture.adapter.destroy();
  const second = fixture.adapter.destroy();
  assert.equal(second, first);
  let secondSettled = false;
  void second.finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  finishCreate();
  await Promise.all([launch, first, second]);
  assert.equal(secondSettled, true);
  await assert.rejects(fixture.adapter.open(), /adapter is destroyed/);
});

test("Cursor SDK launch persists intent before invocation and proves owned discovery", async (t) => {
  let stateObserved;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      stateObserved = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
      fixture.agents.set(input.agentId, { agentId: input.agentId, status: "completed", name: "Fixture agent" });
      return fixture.agents.get(input.agentId);
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  assert.equal(stateObserved.records[0].state, "intent");
  assert.equal(stateObserved.records[0].target, "workspace-a");
  assert.equal(JSON.stringify(stateObserved).includes(fixture.cwd), false);
  assert.equal(JSON.stringify(stateObserved).includes(fixture.storeDirectory), false);
  assert.equal(owned.status, "owned");

  const record = ledgerRecord(owned);
  const agents = await fixture.adapter.discoverOwned([record]);
  assert.equal(agents[0].id, owned.agentId);
  assert.equal(agents[0].status, "idle");
  assert.equal(agents[0].capabilities.read, false);
  assert.equal(agents[0].source, "cursor-sdk");
});

test("Cursor SDK reconciliation never recreates an unconfirmed intent", async (t) => {
  let creates = 0;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      creates += 1;
      throw new Error(`transport lost after ${input.agentId}`);
    },
  });
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /bridge createLocal failed/,
  );
  const result = await fixture.adapter.reconcileLaunch({
    id: LAUNCH_ID,
    attemptId: ATTEMPT_ID,
    request: resolvedRequest(),
  });
  assert.deepEqual(result, { status: "uncertain", code: "cursor_agent_unconfirmed" });
  assert.equal(creates, 1);
});

test("Cursor SDK launch refuses to invoke a bridge twice for one durable attempt", async (t) => {
  let creates = 0;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      creates += 1;
      fixture.agents.set(input.agentId, { agentId: input.agentId });
      return fixture.agents.get(input.agentId);
    },
  });
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /already has durable provenance/,
  );
  assert.equal(creates, 1);
});

test("Cursor SDK rejects stale launch contracts before reserving provenance", async (t) => {
  let creates = 0;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      creates += 1;
      return { agentId: input.agentId };
    },
  });
  const requests = [
    { ...resolvedRequest(), provider: "other" },
    { ...resolvedRequest(), capabilityVersion: "cursor-sdk-local-old" },
    { ...resolvedRequest(), risk: { localMutation: false, externalBillable: true } },
    { ...resolvedRequest(), risk: { localMutation: true, externalBillable: false } },
  ];
  for (const stale of requests) {
    await assert.rejects(
      fixture.adapter.launch(stale, { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
      /does not match the injected adapter configuration/,
    );
  }
  assert.equal(creates, 0);
  await assert.rejects(readFile(fixture.provenanceFile, "utf8"), { code: "ENOENT" });
});

test("Cursor SDK discovery rejects a launch-ledger/provenance mismatch", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await assert.rejects(
    fixture.adapter.discoverOwned([{ ...ledgerRecord(owned), providerAgentId: "agent_tampered" }]),
    /ownership provenance does not match/,
  );
});

test("Cursor SDK discovery rejects a bridge identity mismatch", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.agents.set(owned.providerAgentId, { agentId: "agent_wrong", status: "idle" });
  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)]),
    /unexpected agent identity/,
  );
});

test("Cursor SDK discovery rejects owned ledger request drift", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const record = ledgerRecord(owned);
  record.request.profile = "other";
  await assert.rejects(fixture.adapter.discoverOwned([record]), /ownership provenance does not match/);
});

test("Cursor SDK ownership checks reject risk, capability, and agent identity drift", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });

  const riskDrift = ledgerRecord(owned);
  riskDrift.request.risk.localMutation = false;
  assert.deepEqual(await fixture.adapter.reconcileLaunch(riskDrift), {
    status: "uncertain", code: "cursor_ownership_unproven",
  });

  const capabilityDrift = ledgerRecord(owned);
  capabilityDrift.request.capabilityVersion = "cursor-sdk-local-other";
  await assert.rejects(fixture.adapter.discoverOwned([capabilityDrift]), /ownership provenance does not match/);

  const identityDrift = { ...ledgerRecord(owned), providerAgentId: "agent_tampered" };
  assert.deepEqual(await fixture.adapter.reconcileLaunch(identityDrift), {
    status: "uncertain", code: "cursor_ownership_unproven",
  });
});

test("Cursor SDK discovery recomputes identities instead of trusting matching files", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  const providerAgentId = `agent_${"f".repeat(32)}`;
  state.records[0].providerAgentId = providerAgentId;
  state.records[0].agentId = `cursor-sdk:${state.records[0].storeScope}:${providerAgentId}`;
  await writeFile(fixture.provenanceFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const record = { ...ledgerRecord(owned), providerAgentId, agentId: state.records[0].agentId };
  await assert.rejects(fixture.adapter.discoverOwned([record]), /ownership provenance does not match/);
});

test("Cursor SDK owned discovery returns a non-actionable stale record when the dedicated store is missing the agent", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.agents.clear();
  const [agent] = await fixture.adapter.discoverOwned([ledgerRecord(owned)]);
  assert.equal(agent.status, "unknown");
  assert.deepEqual(agent.capabilities, noCapabilities());
  assert.equal(agent.discovery.confidence, "low");
});

test("Cursor SDK owned discovery preserves healthy records when one bridge lookup fails", async (t) => {
  const fixture = await makeFixture(t);
  const records = [];
  for (let index = 1; index <= 2; index += 1) {
    const uuid = uuidFor(index);
    const attemptId = `attempt:${uuid}`;
    const launchId = `launch:${uuid}`;
    const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId, launchId });
    records.push({
      id: launchId,
      attemptId,
      state: "owned",
      agentId: owned.agentId,
      providerAgentId: owned.providerAgentId,
      request: resolvedRequest(),
    });
  }
  const failedAgentId = records[0].providerAgentId;
  fixture.bridge.getLocal = async ({ agentId }) => {
    if (agentId === failedAgentId) throw new Error("synthetic per-agent lookup failure");
    return fixture.agents.get(agentId) ?? null;
  };

  const agents = await fixture.adapter.discoverOwned(records);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].status, "unknown");
  assert.deepEqual(agents[0].capabilities, noCapabilities());
  assert.equal(agents[0].discovery.confidence, "low");
  assert.equal(agents[1].status, "idle");
  assert.equal(agents[1].discovery.confidence, "high");
});

test("Cursor SDK owned discovery propagates cancellation instead of returning stale", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.bridge.getLocal = async () => { throw new Error("synthetic bridge cancellation"); };
  const controller = new AbortController();
  controller.abort(new Error("synthetic discovery abort"));

  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)], { signal: controller.signal }),
    /synthetic discovery abort/,
  );
});

test("Cursor SDK owned discovery propagates cancellation after a late lookup result", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  let finishLookup;
  const lookupFinished = new Promise((resolve) => { finishLookup = resolve; });
  fixture.bridge.getLocal = async ({ agentId }) => {
    lookupStarted();
    await lookupFinished;
    return fixture.agents.get(agentId) ?? null;
  };
  const controller = new AbortController();
  const abortReason = new Error("synthetic delayed discovery abort");
  const discovery = fixture.adapter.discoverOwned([ledgerRecord(owned)], { signal: controller.signal });
  await started;
  controller.abort(abortReason);
  finishLookup();

  await assert.rejects(discovery, (error) => error === abortReason);
});

test("Cursor SDK owned discovery bounds bridge concurrency", async (t) => {
  const fixture = await makeFixture(t);
  const records = [];
  for (let index = 100; index < 120; index += 1) {
    const uuid = uuidFor(index);
    const attemptId = `attempt:${uuid}`;
    const launchId = `launch:${uuid}`;
    const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId, launchId });
    records.push({
      id: launchId,
      attemptId,
      state: "owned",
      agentId: owned.agentId,
      providerAgentId: owned.providerAgentId,
      request: resolvedRequest(),
    });
  }
  let active = 0;
  let maximum = 0;
  fixture.bridge.getLocal = async ({ agentId }) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return fixture.agents.get(agentId);
  };
  assert.equal((await fixture.adapter.discoverOwned(records)).length, records.length);
  assert.ok(maximum <= 8, `expected bounded concurrency, observed ${maximum}`);
  assert.ok(maximum > 1, `expected concurrent lookups, observed ${maximum}`);
});

test("Cursor SDK owned discovery rechecks its store before each batched lookup", async (t) => {
  const fixture = await makeFixture(t);
  const records = [];
  for (let index = 200; index < 209; index += 1) {
    const uuid = uuidFor(index);
    const attemptId = `attempt:${uuid}`;
    const launchId = `launch:${uuid}`;
    const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId, launchId });
    records.push({
      id: launchId,
      attemptId,
      state: "owned",
      agentId: owned.agentId,
      providerAgentId: owned.providerAgentId,
      request: resolvedRequest(),
    });
  }
  let lookups = 0;
  let initialBatchStarted;
  const started = new Promise((resolve) => { initialBatchStarted = resolve; });
  let finishInitialBatch;
  const initialBatchFinished = new Promise((resolve) => { finishInitialBatch = resolve; });
  fixture.bridge.getLocal = async ({ agentId }) => {
    lookups += 1;
    if (lookups === 8) initialBatchStarted();
    await initialBatchFinished;
    return fixture.agents.get(agentId) ?? null;
  };

  const discovery = fixture.adapter.discoverOwned(records);
  await started;
  await rename(fixture.storeDirectory, `${fixture.storeDirectory}-moved`);
  await mkdir(fixture.storeDirectory, { mode: 0o700 });
  finishInitialBatch();

  await assert.rejects(discovery, /store changed after configuration/);
  assert.equal(lookups, 8);
});

test("normal runtime does not import or register the Cursor SDK adapter", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime.js");
  assert.equal(createRuntimeAdapters().some((adapter) => adapter.id === "cursor-sdk"), false);
  assert.throws(() => new CursorSdkAdapter({}), /explicitly injected bridge/);
});

test("Cursor SDK private state cannot overlap a configured workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "workspace"));
  await mkdir(join(directory, "workspace", "sdk-store"), { mode: 0o700 });
  await mkdir(join(directory, "sdk-store"), { mode: 0o700 });
  await mkdir(join(directory, "private"), { mode: 0o700 });
  const bridge = {
    namespace: "fixture",
    sdkVersion: "1.0.28",
    async createLocal() {},
    async getLocal() {},
  };
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "workspace", "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: "workspace-a", cwd: join(directory, "workspace"), profiles: ["safe"] }],
  }), /private state must be outside/);
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "workspace", "provenance.json"),
    targets: [{ id: "workspace-a", cwd: join(directory, "workspace"), profiles: ["safe"] }],
  }), /private state must be outside/);
});

test("Cursor SDK target configuration rejects invalid profile values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-profiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  await mkdir(join(directory, "sdk-store"), { mode: 0o700 });
  const bridge = {
    namespace: "fixture",
    sdkVersion: "1.0.28",
    async createLocal() {},
    async getLocal() {},
  };
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: "safe" }],
  }), /profiles must be an array/);
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: [123] }],
  }), /profiles must be safe identifiers/);
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: 123, cwd, profiles: ["safe"] }],
  }), /target IDs must be unique safe identifiers/);
});

test("Cursor SDK provenance cannot overlap the bridge-managed store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-store-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  await mkdir(join(directory, "sdk-store"), { mode: 0o700 });
  const bridge = {
    namespace: "fixture",
    sdkVersion: "1.0.28",
    async createLocal() {},
    async getLocal() {},
  };
  assert.throws(() => new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "sdk-store", "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
  }), /provenance state must be outside/);
});

test("Cursor SDK accepts pre-created private state below an ordinary ancestor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-precreated-"));
  let adapter;
  t.after(async () => {
    try { await adapter?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const cwd = join(directory, "workspace");
  const ordinary = join(directory, "ordinary");
  const storeDirectory = join(ordinary, "sdk-store");
  const provenanceDirectory = join(ordinary, "provenance");
  await mkdir(cwd);
  await mkdir(ordinary, { mode: 0o755 });
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(provenanceDirectory, { mode: 0o700 });
  adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile: join(provenanceDirectory, "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  });
  await adapter.open();
  assert.ok(adapter.launchCapabilities());
});

test("Cursor SDK never creates a missing store and rejects linked stores", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-store-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  await mkdir(join(directory, "provenance"), { mode: 0o700 });
  const options = {
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "provenance", "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  };
  assert.throws(() => new CursorSdkAdapter(options), /pre-created private directory/);
  await symlink(cwd, options.storeDirectory);
  assert.throws(() => new CursorSdkAdapter(options), /canonical real directory/);
  await assert.rejects(lstat(join(cwd, "cursor-sdk.json.writer.lock")), { code: "ENOENT" });
});

test("Cursor SDK requires pre-created provenance and an anchored writer-lock capability", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-provenance-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeDirectory = join(directory, "sdk-store");
  await mkdir(cwd);
  await mkdir(storeDirectory, { mode: 0o700 });
  const options = {
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile: join(directory, "private", "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
  };
  assert.throws(() => new CursorSdkAdapter(options), /pre-created private directory/);
  await mkdir(join(directory, "private"), { mode: 0o700 });
  assert.throws(() => new CursorSdkAdapter(options), /injected anchored private-state capabilities/);
});

test("Cursor SDK launch rejects workspace replacement before bridge invocation", async (t) => {
  let creates = 0;
  const fixture = await makeFixture(t, {
    async createLocal() { creates += 1; },
  });
  const moved = `${fixture.cwd}-moved`;
  await rename(fixture.cwd, moved);
  await symlink(moved, fixture.cwd);
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /target changed after configuration/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK launch rechecks workspace after persisting intent", async (t) => {
  let creates = 0;
  let replaced = false;
  const fixture = await makeFixture(t, {
    async createLocal() { creates += 1; },
  }, {
    async afterProvenanceWrite({ cwd }) {
      if (replaced) return;
      replaced = true;
      const moved = `${cwd}-moved`;
      await rename(cwd, moved);
      await symlink(moved, cwd);
    },
  });
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /target changed after configuration/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK launch rejects a plain-directory workspace replacement", async (t) => {
  let creates = 0;
  let replaced = false;
  const fixture = await makeFixture(t, {
    async createLocal() { creates += 1; },
  }, {
    async afterProvenanceWrite({ cwd }) {
      if (replaced) return;
      replaced = true;
      await rename(cwd, `${cwd}-moved`);
      await mkdir(cwd);
    },
  });
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /target changed after configuration/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK validates its pre-created private store and rejects replacement before bridge access", async (t) => {
  let gets = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) {
      gets += 1;
      return fixture.agents.get(agentId) ?? null;
    },
  });
  assert.equal((await lstat(fixture.storeDirectory)).mode & 0o077, 0);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await rename(fixture.storeDirectory, `${fixture.storeDirectory}-moved`);
  await symlink(fixture.cwd, fixture.storeDirectory);
  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)]),
    /store changed after configuration/,
  );
  assert.equal(gets, 0);
});

test("Cursor SDK rejects a store that becomes accessible to other users", async (t) => {
  let gets = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) {
      gets += 1;
      return fixture.agents.get(agentId) ?? null;
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await chmod(fixture.storeDirectory, 0o755);
  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)]),
    /store changed after configuration/,
  );
  assert.equal(gets, 0);
});

test("Cursor SDK provenance admits only one injected writer", async (t) => {
  const first = await makeFixture(t);
  const second = new CursorSdkAdapter({
    bridge: { ...first.bridge, namespace: "fixture-second" },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: first.storeDirectory,
    provenanceFile: first.provenanceFile,
    targets: [{ id: "workspace-a", cwd: first.cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  });
  t.after(() => second.close());
  await first.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await assert.rejects(
    second.open(),
    (error) => error.code === "instance_already_running",
  );
});

test("Cursor SDK rejects provenance directory replacement before another bridge invocation", async (t) => {
  let creates = 0;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      creates += 1;
      return { agentId: input.agentId };
    },
  });
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const privateDirectory = join(fixture.directory, "private");
  const movedDirectory = `${privateDirectory}-moved`;
  await rename(privateDirectory, movedDirectory);
  await mkdir(privateDirectory, { mode: 0o700 });
  await rename(
    join(movedDirectory, "cursor-sdk-provenance.json.writer.lock"),
    `${fixture.provenanceFile}.writer.lock`,
  );
  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /provenance.*changed after configuration/,
  );
  assert.equal(creates, 1);
});

test("Cursor SDK fixture capabilities never mutate a replaced provenance directory", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const privateDirectory = join(fixture.directory, "private");
  await rename(privateDirectory, `${privateDirectory}-moved`);
  await mkdir(privateDirectory, { mode: 0o700 });

  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), {
      attemptId: "attempt:00000000-0000-4000-8000-000000000003",
      launchId: "launch:00000000-0000-4000-8000-000000000003",
    }),
    /changed|identity/,
  );
  await assert.rejects(lstat(fixture.provenanceFile), { code: "ENOENT" });
  await assert.rejects(lstat(`${fixture.provenanceFile}.writer.lock`), { code: "ENOENT" });
});

test("Cursor SDK provenance reopen reacquires its lease after release fails", async (t) => {
  let acquisitions = 0;
  const fixture = await makeFixture(t, {}, {
    fs: fixtureFileSystem({
      async acquireInstanceLock(path, options) {
        await assertAnchoredPrivateState(options);
        acquisitions += 1;
        const lease = await acquireInstanceLock(path, { prepareDirectory: false });
        if (acquisitions !== 1) return lease;
        return {
          ...lease,
          async release() {
            await lease.release();
            throw new Error("synthetic release failure");
          },
        };
      },
    }),
  });

  await assert.rejects(fixture.adapter.close(), /synthetic release failure/);
  await fixture.adapter.open();
  assert.equal(acquisitions, 2);
});

test("Cursor SDK provenance retains its lease when release fails before unlocking", async (t) => {
  let acquisitions = 0;
  let releaseCalls = 0;
  const fixture = await makeFixture(t, {}, {
    fs: fixtureFileSystem({
      async acquireInstanceLock(path, options) {
        await assertAnchoredPrivateState(options);
        acquisitions += 1;
        const lease = await acquireInstanceLock(path, { prepareDirectory: false });
        return {
          ...lease,
          async release() {
            releaseCalls += 1;
            if (releaseCalls === 1) throw new Error("synthetic pre-unlock release failure");
            await lease.release();
          },
        };
      },
    }),
  });

  await assert.rejects(fixture.adapter.close(), /synthetic pre-unlock release failure/);
  await fixture.adapter.open();
  assert.equal(acquisitions, 1);
  await fixture.adapter.close();
  assert.equal(releaseCalls, 2);
  await assert.rejects(lstat(`${fixture.provenanceFile}.writer.lock`), { code: "ENOENT" });
});

test("Cursor SDK close drains in-flight bridge work before releasing its writer lease", async (t) => {
  let second;
  t.after(() => second?.close());
  let bridgeStarted;
  const started = new Promise((resolve) => { bridgeStarted = resolve; });
  let finishBridge;
  const bridgeFinished = new Promise((resolve) => { finishBridge = resolve; });
  const first = await makeFixture(t, {
    async createLocal(input) {
      bridgeStarted();
      await bridgeFinished;
      return { agentId: input.agentId };
    },
  });
  second = new CursorSdkAdapter({
    bridge: { ...first.bridge, namespace: "fixture-second" },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: first.storeDirectory,
    provenanceFile: first.provenanceFile,
    targets: [{ id: "workspace-a", cwd: first.cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  });
  const launch = first.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await started;
  const closing = first.adapter.close();
  await assert.rejects(second.open(), (error) => error.code === "instance_already_running");
  finishBridge();
  await launch;
  await closing;
  await second.open();
});

test("Cursor SDK malformed provenance suppresses capabilities and fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-malformed-"));
  let adapter;
  t.after(async () => {
    await adapter?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const cwd = join(directory, "workspace");
  const privateDirectory = join(directory, "private");
  await mkdir(cwd);
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(join(directory, "sdk-store"), { mode: 0o700 });
  const provenanceFile = join(privateDirectory, "provenance.json");
  await writeFile(provenanceFile, JSON.stringify({ schemaVersion: 999, records: [], secret: "must-not-reset" }), { mode: 0o600 });
  adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile,
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  });
  assert.equal(adapter.launchCapabilities(), null);
  await assert.rejects(adapter.open(), /invalid Cursor SDK provenance state/);
  assert.equal(adapter.launchCapabilities(), null);
  assert.equal((await readFile(provenanceFile, "utf8")).includes("must-not-reset"), true);
});

test("Cursor SDK provenance write failure occurs before bridge invocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-write-failure-"));
  let adapter;
  t.after(async () => {
    await adapter?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  await mkdir(join(directory, "sdk-store"), { mode: 0o700 });
  await mkdir(join(directory, "private"), { mode: 0o700 });
  let creates = 0;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  adapter = new CursorSdkAdapter({
    bridge: {
      namespace: "fixture",
      sdkVersion: "1.0.28",
      async createLocal() { creates += 1; },
      async getLocal() { return null; },
    },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem({
      async readPrivateFileBounded() { throw missing; },
      async writePrivateFileAtomic() { throw new Error("synthetic atomic write failure"); },
    }),
  });
  await adapter.open();
  await assert.rejects(
    adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /synthetic atomic write failure/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK ownership transition uses the injected clock", async (t) => {
  const now = Date.parse("2035-01-02T03:04:05.000Z");
  const fixture = await makeFixture(t, {}, { now: () => now });
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const record = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(record.createdAt, "2035-01-02T03:04:05.000Z");
  assert.equal(record.updatedAt, record.createdAt);
  assert.equal(record.state, "owned");
});

test("Cursor SDK ownership transition remains monotonic when the clock moves backward", async (t) => {
  let now = Date.parse("2035-01-02T03:04:05.000Z");
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      now -= 60_000;
      return { agentId: input.agentId };
    },
  }, { now: () => now });
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const record = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(record.updatedAt, record.createdAt);
  assert.equal(record.state, "owned");
});

test("Cursor SDK provenance capacity rejects before bridge invocation", async (t) => {
  let adapter;
  t.after(() => adapter?.close());
  const fixture = await makeFixture(t);
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  const template = state.records[0];
  state.records = Array.from({ length: 1_000 }, (_, index) => {
    const uuid = uuidFor(index + 10);
    const suffix = (index + 10).toString(16).padStart(32, "0");
    const providerAgentId = `agent_${suffix}`;
    return {
      ...template,
      attemptId: `attempt:${uuid}`,
      launchId: `launch:${uuid}`,
      providerAgentId,
      agentId: `cursor-sdk:${template.storeScope}:${providerAgentId}`,
    };
  });
  await fixture.adapter.close();
  await writeFile(fixture.provenanceFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  let creates = 0;
  adapter = new CursorSdkAdapter({
    bridge: {
      namespace: "fixture",
      sdkVersion: "1.0.28",
      async createLocal() { creates += 1; },
      async getLocal() { return null; },
    },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: fixture.storeDirectory,
    provenanceFile: fixture.provenanceFile,
    targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
    fs: fixtureFileSystem(),
  });
  await adapter.open();
  await assert.rejects(
    adapter.launch(resolvedRequest(), {
      attemptId: "attempt:00000000-0000-4000-8000-ffffffffffff",
      launchId: "launch:00000000-0000-4000-8000-ffffffffffff",
    }),
    /provenance state is full/,
  );
  assert.equal(creates, 0);
});

test("injected Cursor SDK adapter composes with the durable launch coordinator", async (t) => {
  let coordinator;
  let registry;
  t.after(async () => {
    let failure;
    try { await coordinator?.stop(); }
    catch (error) { failure = error; }
    try { await registry?.close(); }
    catch (error) { failure ??= error; }
    if (failure) throw failure;
  });
  const fixture = await makeFixture(t);
  registry = new AgentRegistry([fixture.adapter]);
  coordinator = new LaunchCoordinator(registry, { ledgerFile: join(fixture.directory, "launches.json") });
  await coordinator.start();
  const accepted = await coordinator.submit({
    ...request(),
    confirmations: { localMutation: true, externalBillable: true },
  }, "cursor-fixture-launch");
  await waitFor(() => {
    const record = coordinator.get(accepted.launch.id);
    return record?.state === "owned" && registry.get(record.agentId);
  });
  const agent = registry.get(coordinator.get(accepted.launch.id).agentId);
  assert.equal(agent.provider, "cursor");
  assert.equal(agent.source, "cursor-sdk");
  assert.equal(agent.capabilities.read, false);
  assert.equal((await readFile(ledgerFile, "utf8")).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(logs).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(agent.metadata).includes("fixture-secret"), false);
});

async function makeFixture(t, bridgeOverrides = {}, adapterOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-"));
  const agents = new Map();
  const bridge = {
    namespace: "fixture",
    sdkVersion: "1.0.28",
    async createLocal(input) {
      const agent = { agentId: input.agentId, status: "idle", name: "Fixture agent" };
      agents.set(input.agentId, agent);
      return agent;
    },
    async getLocal({ agentId }) { return agents.get(agentId) ?? null; },
    ...bridgeOverrides,
  };
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const storeDirectory = join(directory, "sdk-store");
  const provenanceFile = join(directory, "private", "cursor-sdk-provenance.json");
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(join(directory, "private"), { mode: 0o700 });
  const fileSystem = adapterOptions.fs ?? fixtureFileSystem(adapterOptions.afterProvenanceWrite ? {
    async writePrivateFileAtomic(...args) {
      await assertAnchoredPrivateState(args[2]);
      await writePrivateFileAtomic(args[0], args[1]);
      await adapterOptions.afterProvenanceWrite({ cwd });
    },
  } : {});
  const adapter = new CursorSdkAdapter({
    bridge,
    credentialSource: adapterOptions.credentialSource ?? fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile,
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    now: adapterOptions.now,
    fs: fileSystem,
  });
  await adapter.open();
  t.after(async () => {
    try { await adapter.destroy(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { adapter, bridge, agents, cwd, directory, storeDirectory, provenanceFile };
}

function fixtureFileSystem(overrides = {}) {
  return {
    async readPrivateFileBounded(path, maximumBytes, options) {
      await assertAnchoredPrivateState(options);
      return readPrivateFileBounded(path, maximumBytes);
    },
    async writePrivateFileAtomic(path, contents, options) {
      await assertAnchoredPrivateState(options);
      return writePrivateFileAtomic(path, contents);
    },
    async acquireInstanceLock(path, options) {
      await assertAnchoredPrivateState(options);
      return acquireInstanceLock(path, { prepareDirectory: false });
    },
    ...overrides,
  };
}

function fixtureCredentialSource(value = "fixture-secret") {
  return createCursorSdkCredentialSource(value);
}

function assertPrivateStateOptions(options) {
  assert.equal(options?.prepareDirectory, false);
  assert.equal(typeof options?.directory, "string");
  assert.equal(typeof options?.directoryIdentity?.dev, "number");
  assert.equal(typeof options?.directoryIdentity?.ino, "number");
}

async function assertAnchoredPrivateState(options) {
  assertPrivateStateOptions(options);
  const live = await lstat(options.directory);
  if (live.dev !== options.directoryIdentity.dev || live.ino !== options.directoryIdentity.ino) {
    throw Object.assign(new Error("private-state directory identity changed"), { code: "EIDENTITY" });
  }
}

function request() { return { provider: "cursor", target: "workspace-a", profile: "safe", mode: "local" }; }
function resolvedRequest() {
  return {
    ...request(),
    risk: { localMutation: true, externalBillable: true },
    capabilityVersion: "cursor-sdk-local-1.0.28",
  };
}
function ledgerRecord(owned) {
  return {
    id: LAUNCH_ID,
    attemptId: ATTEMPT_ID,
    state: "owned",
    agentId: owned.agentId,
    providerAgentId: owned.providerAgentId,
    request: resolvedRequest(),
  };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before timeout");
}

function uuidFor(index) { return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }
