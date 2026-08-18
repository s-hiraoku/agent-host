import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorSdkAdapter } from "../src/adapters/cursor-sdk.js";
import { AgentRegistry } from "../src/core/registry.js";
import { LaunchCoordinator } from "../src/core/launch-coordinator.js";
import { writePrivateFileAtomic } from "../src/secure-state.js";

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

test("Cursor SDK launch persists intent before invocation and proves owned discovery", async (t) => {
  let stateObserved;
  const fixture = await makeFixture(t, {
    async createLocal(input) {
      stateObserved = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
      fixture.agents.set(input.agentId, { agentId: input.agentId, status: "completed", name: "Fixture agent" });
      return fixture.agents.get(input.agentId);
    },
  });
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /transport lost/,
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
  await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await assert.rejects(
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /already has durable provenance/,
  );
  assert.equal(creates, 1);
});

test("Cursor SDK discovery rejects a launch-ledger/provenance mismatch", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await assert.rejects(
    fixture.adapter.discoverOwned([{ ...ledgerRecord(owned), providerAgentId: "agent_tampered" }]),
    /ownership provenance does not match/,
  );
});

test("Cursor SDK discovery rejects a bridge identity mismatch", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.agents.set(owned.providerAgentId, { agentId: "agent_wrong", status: "idle" });
  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)]),
    /unexpected agent identity/,
  );
});

test("Cursor SDK discovery rejects owned ledger request drift", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const record = ledgerRecord(owned);
  record.request.profile = "other";
  await assert.rejects(fixture.adapter.discoverOwned([record]), /ownership provenance does not match/);
});

test("Cursor SDK ownership checks reject risk, capability, and agent identity drift", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });

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
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  const providerAgentId = `agent_${"f".repeat(32)}`;
  state.records[0].providerAgentId = providerAgentId;
  state.records[0].agentId = `cursor-sdk:${state.records[0].storeScope}:${providerAgentId}`;
  await writeFile(fixture.provenanceFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const record = { ...ledgerRecord(owned), providerAgentId, agentId: state.records[0].agentId };
  await assert.rejects(fixture.adapter.discoverOwned([record]), /ownership provenance does not match/);
});

test("Cursor SDK owned discovery fails closed when the dedicated store is missing the agent", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.agents.clear();
  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)]),
    /not present in the dedicated store/,
  );
});

test("Cursor SDK owned discovery bounds bridge concurrency", async (t) => {
  const fixture = await makeFixture(t);
  const records = [];
  for (let index = 100; index < 120; index += 1) {
    const uuid = uuidFor(index);
    const attemptId = `attempt:${uuid}`;
    const launchId = `launch:${uuid}`;
    const owned = await fixture.adapter.launch(request(), { attemptId, launchId });
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

test("normal runtime does not import or register the Cursor SDK adapter", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime.js");
  assert.equal(createRuntimeAdapters().some((adapter) => adapter.id === "cursor-sdk"), false);
  assert.throws(() => new CursorSdkAdapter({}), /explicitly injected bridge/);
});

test("Cursor SDK private state cannot overlap a configured workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "workspace"));
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
});

test("Cursor SDK provenance cannot overlap the bridge-managed store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-store-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
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

test("Cursor SDK does not create its store through a replaced ancestor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-store-ancestor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeAncestor = join(directory, "private");
  await mkdir(cwd);
  await mkdir(storeAncestor);
  const adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory: join(storeAncestor, "nested", "sdk-store"),
    provenanceFile: join(directory, "provenance", "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
  });
  t.after(() => adapter.close());
  await rename(storeAncestor, `${storeAncestor}-moved`);
  await symlink(cwd, storeAncestor);
  await assert.rejects(adapter.open(), /store ancestor changed after configuration/);
  await assert.rejects(lstat(join(cwd, "nested")), { code: "ENOENT" });
});

test("Cursor SDK does not follow a symlink inserted below its pinned store ancestor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-store-component-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeAncestor = join(directory, "private");
  await mkdir(cwd);
  await mkdir(storeAncestor, { mode: 0o700 });
  const adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory: join(storeAncestor, "nested", "sdk-store"),
    provenanceFile: join(directory, "provenance", "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
  });
  t.after(() => adapter.close());
  await symlink(cwd, join(storeAncestor, "nested"));
  await assert.rejects(adapter.open(), /store path changed after configuration/);
  await assert.rejects(lstat(join(cwd, "sdk-store")), { code: "ENOENT" });
});

test("Cursor SDK does not acquire its provenance lock through an inserted symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-provenance-component-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeDirectory = join(directory, "sdk-store");
  const provenanceAncestor = join(directory, "private");
  await mkdir(cwd);
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(provenanceAncestor, { mode: 0o700 });
  const adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile: join(provenanceAncestor, "nested", "cursor-sdk.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
  });
  t.after(() => adapter.close());
  await symlink(cwd, join(provenanceAncestor, "nested"));
  await assert.rejects(adapter.open(), /provenance path changed after configuration/);
  await assert.rejects(lstat(join(cwd, "cursor-sdk.json.writer.lock")), { code: "ENOENT" });
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
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
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
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
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
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /target changed after configuration/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK creates a private store and rejects replacement before bridge access", async (t) => {
  let gets = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) {
      gets += 1;
      return fixture.agents.get(agentId) ?? null;
    },
  });
  assert.equal((await lstat(fixture.storeDirectory)).mode & 0o077, 0);
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
  const owned = await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
    sdkVersion: "1.0.28",
    storeDirectory: first.storeDirectory,
    provenanceFile: first.provenanceFile,
    targets: [{ id: "workspace-a", cwd: first.cwd, profiles: ["safe"] }],
  });
  t.after(() => second.close());
  await first.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
  await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const privateDirectory = join(fixture.directory, "private");
  const movedDirectory = `${privateDirectory}-moved`;
  await rename(privateDirectory, movedDirectory);
  await mkdir(privateDirectory, { mode: 0o700 });
  await rename(
    join(movedDirectory, "cursor-sdk-provenance.json.writer.lock"),
    `${fixture.provenanceFile}.writer.lock`,
  );
  await assert.rejects(
    fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /provenance.*changed after configuration/,
  );
  assert.equal(creates, 1);
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
    sdkVersion: "1.0.28",
    storeDirectory: first.storeDirectory,
    provenanceFile: first.provenanceFile,
    targets: [{ id: "workspace-a", cwd: first.cwd, profiles: ["safe"] }],
  });
  const launch = first.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
  const provenanceFile = join(privateDirectory, "provenance.json");
  await writeFile(provenanceFile, JSON.stringify({ schemaVersion: 999, records: [], secret: "must-not-reset" }), { mode: 0o600 });
  adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile,
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
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
  let creates = 0;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  adapter = new CursorSdkAdapter({
    bridge: {
      namespace: "fixture",
      sdkVersion: "1.0.28",
      async createLocal() { creates += 1; },
      async getLocal() { return null; },
    },
    sdkVersion: "1.0.28",
    storeDirectory: join(directory, "sdk-store"),
    provenanceFile: join(directory, "private", "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    fs: {
      async readPrivateFileBounded() { throw missing; },
      async writePrivateFileAtomic() { throw new Error("synthetic atomic write failure"); },
    },
  });
  await adapter.open();
  await assert.rejects(
    adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID }),
    /synthetic atomic write failure/,
  );
  assert.equal(creates, 0);
});

test("Cursor SDK ownership transition uses the injected clock", async (t) => {
  const now = Date.parse("2035-01-02T03:04:05.000Z");
  const fixture = await makeFixture(t, {}, { now: () => now });
  await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
  await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  const record = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(record.updatedAt, record.createdAt);
  assert.equal(record.state, "owned");
});

test("Cursor SDK provenance capacity rejects before bridge invocation", async (t) => {
  let adapter;
  t.after(() => adapter?.close());
  const fixture = await makeFixture(t);
  await fixture.adapter.launch(request(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
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
    sdkVersion: "1.0.28",
    storeDirectory: fixture.storeDirectory,
    provenanceFile: fixture.provenanceFile,
    targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
  });
  await adapter.open();
  await assert.rejects(
    adapter.launch(request(), {
      attemptId: "attempt:00000000-0000-4000-8000-ffffffffffff",
      launchId: "launch:00000000-0000-4000-8000-ffffffffffff",
    }),
    /provenance state is full/,
  );
  assert.equal(creates, 0);
});

test("injected Cursor SDK adapter composes with the durable launch coordinator", async (t) => {
  const fixture = await makeFixture(t);
  const registry = new AgentRegistry([fixture.adapter]);
  const coordinator = new LaunchCoordinator(registry, { ledgerFile: join(fixture.directory, "launches.json") });
  await coordinator.start();
  t.after(async () => {
    await coordinator.stop();
    await registry.close();
  });
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
  const adapter = new CursorSdkAdapter({
    bridge,
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile,
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    now: adapterOptions.now,
    fs: adapterOptions.afterProvenanceWrite ? {
      async writePrivateFileAtomic(...args) {
        await writePrivateFileAtomic(...args);
        await adapterOptions.afterProvenanceWrite({ cwd });
      },
    } : undefined,
  });
  await adapter.open();
  t.after(async () => {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { adapter, bridge, agents, cwd, directory, storeDirectory, provenanceFile };
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
