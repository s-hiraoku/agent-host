import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

test("Cursor SDK retires only an exact terminal owned agent behind a durable fence", async (t) => {
  let status = "idle";
  let deletes = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status }; },
    async deleteLocal({ agentId }) {
      deletes += 1;
      fixture.agents.delete(agentId);
      return { agentId, deleted: true };
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const retirementKeyHash = "r".repeat(43);
  const retiring = { ...ledgerRecord(owned), state: "retiring", retirementKeyHash };
  status = "working";
  assert.deepEqual(await fixture.adapter.retireLaunch(retiring), {
    status: "blocked", code: "cursor_agent_not_terminal",
  });
  assert.equal(deletes, 0);
  status = "idle";
  const retired = await fixture.adapter.retireLaunch(retiring);
  assert.equal(retired.status, "retired");
  assert.match(retired.cleanupScope, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(deletes, 1);
  let state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "retired");
  assert.equal(state.records[0].retirementKeyHash, retirementKeyHash);
  assert.deepEqual(await fixture.adapter.retireLaunch(retiring), retired);
  assert.equal(deletes, 1);
  const wrongScope = retired.cleanupScope === "x".repeat(16) ? "y".repeat(16) : "x".repeat(16);
  assert.equal(await fixture.adapter.finalizeLaunchRetirement({
    provider: "cursor", attemptId: ATTEMPT_ID, keyHash: retirementKeyHash,
    cleanupScope: wrongScope,
  }), false);
  state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "retired");
  const cleanup = {
    provider: "cursor", attemptId: ATTEMPT_ID, keyHash: retirementKeyHash,
    cleanupScope: retired.cleanupScope,
  };
  assert.equal(await fixture.adapter.finalizeLaunchRetirement(cleanup), true);
  assert.equal(await fixture.adapter.finalizeLaunchRetirement(cleanup), true);
  state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.deepEqual(state.records, []);
});

test("Cursor SDK reserves the complete provenance retirement fence before deletion", async (t) => {
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: "idle" }; },
    async deleteLocal({ agentId }) { return { agentId, deleted: true }; },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const record = ledgerRecord(owned);
  const retirementKeyHash = "r".repeat(43);
  assert.deepEqual(await fixture.adapter.prepareLaunchRetirement(record, {
    keyHash: retirementKeyHash,
  }), { status: "prepared" });
  assert.deepEqual(await fixture.adapter.prepareLaunchRetirement(record, {
    keyHash: retirementKeyHash,
  }), { status: "prepared" });
  await assert.rejects(
    fixture.adapter.prepareLaunchRetirement(record, { keyHash: "x".repeat(43) }),
    /retirement reservation changed/,
  );
  assert.equal(await fixture.adapter.cancelLaunchRetirementPreparation(record, {
    keyHash: retirementKeyHash,
  }), true);
  assert.deepEqual(await fixture.adapter.prepareLaunchRetirement(record, {
    keyHash: "x".repeat(43),
  }), { status: "prepared" });
  assert.equal(await fixture.adapter.cancelLaunchRetirementPreparation(record, {
    keyHash: "x".repeat(43),
  }), true);
  assert.deepEqual(await fixture.adapter.prepareLaunchRetirement(record, {
    keyHash: retirementKeyHash,
  }), { status: "prepared" });
  let state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "owned");
  assert.equal(state.records[0].retirementKeyHash, retirementKeyHash);
  assert.equal(state.records[0].retirementReserved, true);
  assert.equal(state.records[0].deleteAttempted, false);

  const retired = await fixture.adapter.retireLaunch({
    ...record, state: "retiring", retirementKeyHash,
  });
  assert.equal(retired.status, "retired");
  state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "retired");
  assert.equal(state.records[0].retirementReserved, undefined);
  assert.equal(state.records[0].deleteAttempted, undefined);
});

test("Cursor SDK restores owned provenance when the first delete is definitively rejected", async (t) => {
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: "idle" }; },
    async deleteLocal() {
      const error = new Error("agent was absent before deletion");
      error.deleteDisposition = "rejected";
      throw error;
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const retirementKeyHash = "r".repeat(43);
  assert.deepEqual(await fixture.adapter.retireLaunch({
    ...ledgerRecord(owned), state: "retiring", retirementKeyHash,
  }), { status: "blocked", code: "cursor_delete_rejected" });
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "owned");
  assert.equal(state.records[0].retirementKeyHash, undefined);
  assert.equal(state.records[0].retirementReserved, undefined);
  assert.equal(state.records[0].deleteAttempted, undefined);
});

test("Cursor SDK restores recovered provenance when pre-delete checks become blocked", async (t) => {
  let status = "working";
  let deletes = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status }; },
    async deleteLocal({ agentId }) {
      deletes += 1;
      return { agentId, deleted: true };
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const firstKeyHash = "r".repeat(43);
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  state.records[0].state = "retiring";
  state.records[0].retirementKeyHash = firstKeyHash;
  await writePrivateFileAtomic(fixture.provenanceFile, `${JSON.stringify(state)}\n`);

  assert.deepEqual(await fixture.adapter.retireLaunch({
    ...ledgerRecord(owned), state: "retiring", retirementKeyHash: firstKeyHash,
  }), { status: "blocked", code: "cursor_agent_not_terminal" });
  const restored = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(restored.records[0].state, "owned");
  assert.equal(restored.records[0].retirementKeyHash, undefined);
  assert.equal(restored.records[0].retirementReserved, undefined);
  assert.equal(restored.records[0].deleteAttempted, undefined);
  assert.equal(deletes, 0);

  status = "idle";
  const secondKeyHash = "x".repeat(43);
  const retired = await fixture.adapter.retireLaunch({
    ...ledgerRecord(owned), state: "retiring", retirementKeyHash: secondKeyHash,
  });
  assert.equal(retired.status, "retired");
  assert.match(retired.cleanupScope, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(deletes, 1);
});

test("Cursor SDK accepts not-found only after a durably attempted delete", async (t) => {
  let deletes = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: "idle" }; },
    async deleteLocal({ agentId, allowNotFound }) {
      deletes += 1;
      if (deletes === 1) {
        const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
        assert.equal(state.records[0].deleteAttempted, true);
        const error = new Error("delete response was lost");
        error.deleteDisposition = "ambiguous";
        throw error;
      }
      assert.equal(allowNotFound, true);
      return { agentId, deleted: true };
    },
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const retirementKeyHash = "r".repeat(43);
  const retiring = { ...ledgerRecord(owned), state: "retiring", retirementKeyHash };
  await assert.rejects(
    fixture.adapter.retireLaunch(retiring),
    (error) => error.code === "cursor_bridge_failed" && error.deleteDisposition === "ambiguous",
  );
  let state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].deleteAttempted, true);
  const retired = await fixture.adapter.retireLaunch(retiring);
  assert.equal(retired.status, "retired");
  assert.match(retired.cleanupScope, /^[A-Za-z0-9_-]{16}$/);
  state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "retired");
  assert.equal(state.records[0].deleteAttempted, undefined);
});

test("Cursor SDK does not retain a delete attempt when credentials fail before invocation", async (t) => {
  let credentialCalls = 0;
  let status = "idle";
  let deletes = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status }; },
    async deleteLocal({ agentId }) {
      deletes += 1;
      return { agentId, deleted: true };
    },
  }, {
    credentialSource: createCursorSdkCredentialSource(() => {
      credentialCalls += 1;
      if (credentialCalls === 3) throw new Error("credential unavailable before delete");
      return "cursor-fixture-secret";
    }),
  });
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const retirementKeyHash = "r".repeat(43);
  const retiring = { ...ledgerRecord(owned), state: "retiring", retirementKeyHash };
  await assert.rejects(
    fixture.adapter.retireLaunch(retiring),
    (error) => error.code === "cursor_credential_unavailable",
  );
  let state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "retiring");
  assert.equal(state.records[0].deleteAttempted, undefined);
  assert.equal(deletes, 0);

  status = "working";
  assert.deepEqual(await fixture.adapter.retireLaunch(retiring), {
    status: "blocked", code: "cursor_agent_not_terminal",
  });
  state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records[0].state, "owned");
  assert.equal(state.records[0].retirementKeyHash, undefined);
  assert.equal(state.records[0].retirementReserved, undefined);
  assert.equal(state.records[0].deleteAttempted, undefined);
  assert.equal(deletes, 0);
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
    privateState: fixtureFileSystem(dirname(fixture.provenanceFile)),
  };
  assert.throws(
    () => new CursorSdkAdapter(options),
    /explicitly injected credential source/,
  );
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: { secret: "cursor-fixture-secret" } }),
    /explicitly injected credential source/,
  );
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: Object.freeze({}) }),
    /explicitly injected credential source/,
  );
  let propertyReads = 0;
  const proxy = new Proxy({}, {
    get() {
      propertyReads += 1;
      return { claim() { return {}; } };
    },
  });
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: proxy }),
    /explicitly injected credential source/,
  );
  assert.equal(propertyReads, 0);
  const source = fixtureCredentialSource();
  const assigned = new CursorSdkAdapter({ ...options, credentialSource: source });
  t.after(() => assigned.destroy());
  assert.throws(
    () => new CursorSdkAdapter({ ...options, credentialSource: new Proxy(source, {
      get() { propertyReads += 1; return undefined; },
    }) }),
    /explicitly injected credential source/,
  );
  assert.equal(propertyReads, 0);
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

test("Cursor SDK exposes prompt and exact-run interrupt only for a current owned agent", async (t) => {
  const prompt = "private prompt that must not be persisted";
  let status = "idle";
  let interruptible = false;
  let sent = 0;
  let cancelled = 0;
  let observedCredential;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId, credential }) {
      observedCredential = credential;
      return { agentId, status, interruptible, name: "Owned action agent" };
    },
    async sendLocal({ agentId, text, credential }) {
      observedCredential = credential;
      assert.equal(text, prompt);
      sent += 1;
      status = "working";
      interruptible = true;
      return { agentId, runId: "run-owned-1", status };
    },
    async inspectRunLocal({ agentId, runId }) {
      return { agentId, runId, status: status === "working" ? "working" : "terminal" };
    },
    async cancelLocal({ agentId, runId, credential }) {
      observedCredential = credential;
      cancelled += 1;
      interruptible = false;
      return { agentId, runId, status: "cancelling" };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const record = ledgerRecord(owned);
  const idle = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(idle.capabilities.prompt, true);
  assert.equal(idle.capabilities.interrupt, false);
  status = "working";
  await assert.rejects(fixture.adapter.prompt(idle, prompt), /current Bridge capability/);
  assert.equal(sent, 0);
  status = "idle";
  assert.deepEqual(await fixture.adapter.prompt(idle, prompt), {
    ok: true, agentId: owned.agentId, action: "prompt",
  });
  assert.equal(sent, 1);
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  const working = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(working.capabilities.prompt, false);
  assert.equal(working.capabilities.interrupt, true);
  status = "done";
  await assert.rejects(fixture.adapter.interrupt(working), /current Bridge capability/);
  assert.equal(cancelled, 0);
  status = "working";
  assert.deepEqual(await fixture.adapter.interrupt(working), {
    ok: true, agentId: owned.agentId, action: "interrupt",
  });
  assert.equal(cancelled, 1);
  assert.equal(observedCredential.every((byte) => byte === 0), true);
  const cancelling = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(cancelling.capabilities.prompt, false);
  assert.equal(cancelling.capabilities.interrupt, false);
  assert.equal((await readFile(fixture.provenanceFile, "utf8")).includes(prompt), false);
  await assert.rejects(
    fixture.adapter.prompt({ ...idle, id: "cursor-sdk:spoofed", capabilities: { ...idle.capabilities, prompt: true } }, prompt),
    /ownership could not be proven/,
  );
});

test("Cursor SDK persists an exact prompted run and reads it after restart only when terminal", async (t) => {
  let status = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) {
      return { agentId, status, name: "Readable owned agent", interruptible: status === "working" };
    },
    async sendLocal({ agentId }) {
      status = "working";
      return { agentId, runId: "run-owned-readable", status };
    },
    async inspectRunLocal({ agentId, runId }) {
      return { agentId, runId, status: status === "working" ? "working" : "terminal" };
    },
    async cancelLocal({ agentId }) { return { agentId, status: "cancelling" }; },
    async readRunLocal({ agentId, runId }) {
      return {
        agentId,
        runId,
        messages: [
          { role: "user", text: "fixture-secret must be redacted" },
          { role: "assistant", text: "done" },
        ],
        messageCount: 2,
        omittedBlockCount: 3,
        truncated: false,
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const record = ledgerRecord(owned);
  const initial = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(initial.capabilities.read, false);
  await fixture.adapter.prompt(initial, "record this exact run");
  const persisted = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(persisted.runId, "run-owned-readable");
  const working = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(working.capabilities.read, false);
  status = "done";
  const terminal = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(terminal.capabilities.read, true);
  await fixture.adapter.close();
  await fixture.adapter.open();
  const restarted = (await fixture.adapter.discoverOwned([record]))[0];
  assert.equal(restarted.capabilities.read, true);
  assert.deepEqual(await fixture.adapter.read(restarted), {
    ok: true,
    agentId: owned.agentId,
    action: "read",
    data: {
      messages: [
        { role: "user", text: "[REDACTED] must be redacted" },
        { role: "assistant", text: "done" },
      ],
      messageCount: 2,
      omittedBlockCount: 3,
      truncated: false,
    },
  });
});

test("Cursor SDK advertises read only after exact terminal-run proof", async (t) => {
  let agentStatus = "idle";
  let inspection = "working";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: agentStatus }; },
    async sendLocal({ agentId }) { return { agentId, runId: "run-read-proof", status: "working" }; },
    async inspectRunLocal({ agentId, runId }) {
      if (inspection === "failure") throw new Error("synthetic GetRun failure");
      return {
        agentId: inspection === "mismatch" ? "agent-other" : agentId,
        runId,
        status: inspection,
      };
    },
    async readRunLocal({ agentId, runId }) {
      return { agentId, runId, messages: [], messageCount: 0, omittedBlockCount: 0, truncated: false };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  await fixture.adapter.prompt((await fixture.adapter.discoverOwned([ledger]))[0], "start");
  agentStatus = "idle";
  for (const unproven of ["working", "creating", "mismatch", "failure"]) {
    inspection = unproven;
    const agent = (await fixture.adapter.discoverOwned([ledger]))[0];
    assert.equal(agent.capabilities.read, false, unproven);
    assert.equal(agent.capabilities.prompt, false, unproven);
  }
  inspection = "terminal";
  const terminal = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(terminal.capabilities.read, true);
  assert.equal(terminal.capabilities.prompt, true);
});

test("Cursor SDK interrupts its exact durable run after restart and fences repeat cancellation", async (t) => {
  let agentStatus = "idle";
  let runStatus = "terminal";
  let sendMode = "success";
  let sends = 0;
  const cancellations = [];
  const inspections = [];
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: agentStatus }; },
    async inspectRunLocal({ agentId, runId }) {
      inspections.push(runId);
      return { agentId, runId, status: runStatus };
    },
    async sendLocal({ agentId }) {
      if (sendMode === "rejected") {
        const error = new Error("definitive replacement rejection");
        error.sendDisposition = "rejected";
        throw error;
      }
      sends += 1;
      agentStatus = "working";
      runStatus = "working";
      return { agentId, runId: `run-durable-${sends}`, status: "working" };
    },
    async cancelLocal({ agentId, runId }) {
      cancellations.push(runId);
      return { agentId, runId, status: "cancelling" };
    },
    async readRunLocal({ agentId, runId }) {
      return { agentId, runId, messages: [], messageCount: 0, omittedBlockCount: 0, truncated: false };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  const idle = (await fixture.adapter.discoverOwned([ledger]))[0];
  await fixture.adapter.prompt(idle, "start durable run");

  await fixture.adapter.close();
  await fixture.adapter.open();
  const restarted = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(restarted.capabilities.interrupt, true);
  const concurrent = await Promise.allSettled([
    fixture.adapter.interrupt(restarted),
    fixture.adapter.interrupt(restarted),
  ]);
  assert.deepEqual(concurrent[0], { status: "fulfilled", value: {
    ok: true, agentId: owned.agentId, action: "interrupt",
  } });
  assert.equal(concurrent[1].status, "rejected");
  assert.match(concurrent[1].reason.message, /current Bridge capability/);
  assert.deepEqual(cancellations, ["run-durable-1"]);
  let provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-durable-1");
  assert.equal(provenance.cancelAttemptedRunId, "run-durable-1");

  await fixture.adapter.close();
  await fixture.adapter.open();
  const fenced = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(fenced.capabilities.interrupt, false);
  assert.equal(fenced.capabilities.prompt, false);
  await assert.rejects(fixture.adapter.interrupt(restarted), /current Bridge capability/);
  assert.deepEqual(cancellations, ["run-durable-1"]);

  agentStatus = "done";
  runStatus = "terminal";
  const terminal = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(terminal.capabilities.read, true);
  assert.equal(terminal.capabilities.prompt, true);
  assert.deepEqual(await fixture.adapter.read(terminal), {
    ok: true,
    agentId: owned.agentId,
    action: "read",
    data: { messages: [], messageCount: 0, omittedBlockCount: 0, truncated: false },
  });
  sendMode = "rejected";
  await assert.rejects(fixture.adapter.prompt(terminal, "rejected replacement"), /bridge sendLocal failed/);
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.cancelAttemptedRunId, "run-durable-1");
  sendMode = "success";
  await fixture.adapter.prompt(terminal, "start replacement run");
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-durable-2");
  assert.equal(provenance.cancelAttemptedRunId, undefined);
  assert.ok(inspections.every((runId) => runId === "run-durable-1"));
});

test("Cursor SDK restores only definitive cancel failures and retains ambiguous fences", async (t) => {
  let cancellation = "rejected";
  let cancelCalls = 0;
  let agentStatus = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: agentStatus }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "working" }; },
    async sendLocal({ agentId }) {
      agentStatus = "working";
      return { agentId, runId: "run-cancel-failure", status: "working" };
    },
    async cancelLocal({ agentId, runId }) {
      cancelCalls += 1;
      if (cancellation !== "success") {
        const error = new Error(cancellation);
        if (cancellation === "rejected") error.cancelDisposition = "rejected";
        throw error;
      }
      return { agentId, runId, status: "cancelling" };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  const initial = (await fixture.adapter.discoverOwned([ledger]))[0];
  await fixture.adapter.prompt(initial, "start");
  let working = (await fixture.adapter.discoverOwned([ledger]))[0];

  await assert.rejects(fixture.adapter.interrupt(working), /bridge cancelLocal failed/);
  let provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.cancelAttemptedRunId, undefined);
  working = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(working.capabilities.interrupt, true);

  cancellation = "ambiguous";
  await assert.rejects(fixture.adapter.interrupt(working), /bridge cancelLocal failed/);
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.cancelAttemptedRunId, "run-cancel-failure");
  await fixture.adapter.close();
  await fixture.adapter.open();
  working = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(working.capabilities.interrupt, false);
  assert.equal(cancelCalls, 2);
});

test("Cursor SDK persists the cancel fence before invoking the Bridge", async (t) => {
  let writes = 0;
  let cancelCalls = 0;
  let agentStatus = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: agentStatus }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "working" }; },
    async sendLocal({ agentId }) {
      agentStatus = "working";
      return { agentId, runId: "run-before-cancel-write", status: "working" };
    },
    async cancelLocal({ agentId, runId }) {
      cancelCalls += 1;
      return { agentId, runId, status: "cancelling" };
    },
  }, {
    privateStateFactory(directory) {
      const state = fixtureFileSystem(directory);
      const write = state.writeFileAtomic.bind(state);
      return {
        ...state,
        async writeFileAtomic(name, contents) {
          writes += 1;
          if (writes === 5) throw new Error("synthetic cancel-fence write failure");
          return write(name, contents);
        },
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  await fixture.adapter.prompt((await fixture.adapter.discoverOwned([ledger]))[0], "start");
  const working = (await fixture.adapter.discoverOwned([ledger]))[0];
  await assert.rejects(fixture.adapter.interrupt(working), /synthetic cancel-fence write failure/);
  assert.equal(cancelCalls, 0);
  const provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-before-cancel-write");
  assert.equal(provenance.cancelAttemptedRunId, undefined);
});

test("Cursor SDK remains fenced when restoring a definitive cancel failure cannot persist", async (t) => {
  let writes = 0;
  let agentStatus = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: agentStatus }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "working" }; },
    async sendLocal({ agentId }) {
      agentStatus = "working";
      return { agentId, runId: "run-restore-failure", status: "working" };
    },
    async cancelLocal() {
      const error = new Error("definitive rejection");
      error.cancelDisposition = "rejected";
      throw error;
    },
  }, {
    privateStateFactory(directory) {
      const state = fixtureFileSystem(directory);
      const write = state.writeFileAtomic.bind(state);
      return {
        ...state,
        async writeFileAtomic(name, contents) {
          writes += 1;
          if (writes === 6) throw new Error("synthetic cancel-fence restore failure");
          return write(name, contents);
        },
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  await fixture.adapter.prompt((await fixture.adapter.discoverOwned([ledger]))[0], "start");
  const working = (await fixture.adapter.discoverOwned([ledger]))[0];
  await assert.rejects(fixture.adapter.interrupt(working), /bridge cancelLocal failed/);
  let provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.cancelAttemptedRunId, "run-restore-failure");
  await fixture.adapter.close();
  await fixture.adapter.open();
  const restarted = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(restarted.capabilities.interrupt, false);
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.cancelAttemptedRunId, "run-restore-failure");
});

test("Cursor SDK serializes prompts so a losing prompt cannot erase exact-run provenance", async (t) => {
  let status = "idle";
  let sends = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status, interruptible: false }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "terminal" }; },
    async sendLocal({ agentId }) {
      sends += 1;
      status = "working";
      return { agentId, runId: "run-owned-first", status };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const idle = (await fixture.adapter.discoverOwned([ledgerRecord(owned)]))[0];
  const first = fixture.adapter.prompt(idle, "first");
  const second = fixture.adapter.prompt(idle, "second");
  await first;
  await assert.rejects(second, /current Bridge capability/);
  assert.equal(sends, 1);
  assert.equal(
    JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0].runId,
    "run-owned-first",
  );
});

test("Cursor SDK fails a prompt closed without an unfenced cancel when exact-run persistence fails", async (t) => {
  let writes = 0;
  let cancellations = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status: "idle", interruptible: false }; },
    async sendLocal({ agentId }) {
      return { agentId, runId: "run-unpersisted", status: "working" };
    },
    async cancelLocal({ agentId }) {
      cancellations += 1;
      return { agentId, status: "cancelling" };
    },
  }, {
    privateStateFactory(directory) {
      const state = fixtureFileSystem(directory);
      const write = state.writeFileAtomic.bind(state);
      return {
        ...state,
        async writeFileAtomic(name, contents) {
          writes += 1;
          if (writes === 4) throw new Error("synthetic exact-run write failure");
          return write(name, contents);
        },
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const idle = (await fixture.adapter.discoverOwned([ledgerRecord(owned)]))[0];
  await assert.rejects(
    fixture.adapter.prompt(idle, "must not report success"),
    /synthetic exact-run write failure/,
  );
  assert.equal(cancellations, 0);
  const provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, undefined);
  assert.equal(provenance.runPending, true);
});

test("Cursor SDK never compensates with an unfenced cancel after an ambiguous run commit", async (t) => {
  let committedRun = false;
  let failPostCommit = true;
  let cancellations = 0;
  let status = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "working" }; },
    async sendLocal({ agentId }) {
      status = "working";
      return { agentId, runId: "run-commit-ambiguous", status };
    },
    async cancelLocal({ agentId, runId }) {
      cancellations += 1;
      return { agentId, runId, status: "cancelling" };
    },
  }, {
    privateStateFactory(directory) {
      const state = fixtureFileSystem(directory);
      const write = state.writeFileAtomic.bind(state);
      const assertCurrent = state.assertCurrent.bind(state);
      return {
        ...state,
        async writeFileAtomic(name, contents) {
          await write(name, contents);
          committedRun = contents.includes("run-commit-ambiguous");
        },
        async assertCurrent() {
          if (committedRun && failPostCommit) {
            failPostCommit = false;
            throw new Error("synthetic post-commit acknowledgement failure");
          }
          return assertCurrent();
        },
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  await assert.rejects(
    fixture.adapter.prompt((await fixture.adapter.discoverOwned([ledger]))[0], "start"),
    /synthetic post-commit acknowledgement failure/,
  );
  assert.equal(cancellations, 0);
  const provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-commit-ambiguous");
  assert.equal(provenance.runPending, undefined);
  assert.equal(provenance.cancelAttemptedRunId, undefined);
  await fixture.adapter.close();
  await fixture.adapter.open();
  const restarted = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(restarted.capabilities.interrupt, true);
});

test("Cursor SDK retains the prior readable run on pre-delivery failures and fences ambiguity", async (t) => {
  let status = "idle";
  let delivery = "success";
  let run = 0;
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status, interruptible: false }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "terminal" }; },
    async sendLocal({ agentId }) {
      if (delivery === "definite") {
        const error = new Error("not sent");
        error.sendDisposition = "not_sent";
        throw error;
      }
      if (delivery === "ambiguous") throw new Error("delivery unknown");
      run += 1;
      status = "working";
      return { agentId, runId: `run-owned-${run}`, status };
    },
    async readRunLocal({ agentId, runId }) {
      return {
        agentId, runId, messages: [], messageCount: 0, omittedBlockCount: 0, truncated: false,
      };
    },
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  const idle = (await fixture.adapter.discoverOwned([ledger]))[0];
  await fixture.adapter.prompt(idle, "first successful prompt");
  status = "done";
  let terminal = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(terminal.capabilities.read, true);

  await assert.rejects(fixture.adapter.prompt(terminal, ""), /must be non-empty/);
  let provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-owned-1");
  assert.equal(provenance.runPending, undefined);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.adapter.prompt(terminal, "aborted", { signal: controller.signal }),
    (error) => error.code === "cursor_operation_cancelled");
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-owned-1");
  assert.equal(provenance.runPending, undefined);

  delivery = "definite";
  await assert.rejects(fixture.adapter.prompt(terminal, "definitely rejected"), /bridge sendLocal failed/);
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-owned-1");
  assert.equal(provenance.runPending, undefined);
  terminal = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(terminal.capabilities.read, true);

  delivery = "ambiguous";
  await assert.rejects(fixture.adapter.prompt(terminal, "ambiguous delivery"), /bridge sendLocal failed/);
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-owned-1");
  assert.equal(provenance.runPending, true);
  const fenced = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(fenced.capabilities.prompt, false);
  assert.equal(fenced.capabilities.read, false);

  delivery = "definite";
  await assert.rejects(
    fixture.adapter.prompt(terminal, "must not clear the earlier ambiguity"),
    /current Bridge capability/,
  );
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-owned-1");
  assert.equal(provenance.runPending, true);
});

test("Cursor SDK restores the prior run when credential acquisition fails before send", async (t) => {
  const secret = "cursor-fixture-secret";
  let credentialMode = "ready";
  let credentialCallsInMode = 0;
  let releaseCredential;
  let credentialPending;
  let bridgeSends = 0;
  let status = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status, interruptible: false }; },
    async inspectRunLocal({ agentId, runId }) { return { agentId, runId, status: "terminal" }; },
    async sendLocal({ agentId }) {
      bridgeSends += 1;
      status = "working";
      return { agentId, runId: "run-before-credential-failure", status };
    },
    async readRunLocal({ agentId, runId }) {
      return { agentId, runId, messages: [], messageCount: 0, omittedBlockCount: 0, truncated: false };
    },
  }, {
    credentialSource: createCursorSdkCredentialSource(async () => {
      credentialCallsInMode += 1;
      if (credentialMode === "fail" && credentialCallsInMode === 2) throw new Error(secret);
      if (credentialMode === "delay" && credentialCallsInMode === 2) {
        credentialPending = new Promise((resolve) => { releaseCredential = resolve; });
        await credentialPending;
      }
      return secret;
    }),
  });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const ledger = ledgerRecord(owned);
  const idle = (await fixture.adapter.discoverOwned([ledger]))[0];
  await fixture.adapter.prompt(idle, "record readable run");
  status = "done";
  const terminal = (await fixture.adapter.discoverOwned([ledger]))[0];
  assert.equal(terminal.capabilities.read, true);

  credentialMode = "fail";
  credentialCallsInMode = 0;
  await assert.rejects(
    fixture.adapter.prompt(terminal, "credential callback fails"),
    (error) => error.code === "cursor_credential_unavailable",
  );
  let provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-before-credential-failure");
  assert.equal(provenance.runPending, undefined);
  assert.equal(bridgeSends, 1);

  credentialMode = "ready";
  credentialCallsInMode = 0;
  const restored = (await fixture.adapter.discoverOwned([ledger]))[0];
  credentialMode = "delay";
  credentialCallsInMode = 0;
  releaseCredential = undefined;
  const controller = new AbortController();
  const prompting = fixture.adapter.prompt(restored, "cancel credential acquisition", {
    signal: controller.signal,
  });
  await waitFor(() => Boolean(releaseCredential));
  controller.abort();
  releaseCredential(secret);
  await assert.rejects(prompting, (error) => error.code === "cursor_operation_cancelled");
  provenance = JSON.parse(await readFile(fixture.provenanceFile, "utf8")).records[0];
  assert.equal(provenance.runId, "run-before-credential-failure");
  assert.equal(provenance.runPending, undefined);
  assert.equal(bridgeSends, 1);
});

test("Cursor SDK reapplies text bounds after expanding credential redaction", async (t) => {
  const secret = "\u79d8\u5bc6\u9375";
  let status = "idle";
  const fixture = await makeFixture(t, {
    async getLocal({ agentId }) { return { agentId, status, interruptible: false }; },
    async inspectRunLocal({ agentId, runId }) {
      return { agentId, runId, status: status === "working" ? "working" : "terminal" };
    },
    async sendLocal({ agentId }) {
      status = "working";
      return { agentId, runId: "run-redaction-bounds", status };
    },
    async readRunLocal({ agentId, runId }) {
      return {
        agentId,
        runId,
        messages: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          text: `${secret}${String(index).padStart(2, "0")}${"x".repeat(8_187)}`,
        })),
        messageCount: 10,
        omittedBlockCount: 0,
        truncated: false,
      };
    },
  }, { credentialSource: createCursorSdkCredentialSource(secret) });
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  const idle = (await fixture.adapter.discoverOwned([ledgerRecord(owned)]))[0];
  await fixture.adapter.prompt(idle, "record bounded read");
  status = "done";
  const terminal = (await fixture.adapter.discoverOwned([ledgerRecord(owned)]))[0];
  const result = await fixture.adapter.read(terminal);
  assert.equal(result.data.messages.length, 8);
  assert.equal(result.data.messages.reduce((sum, message) => sum + message.text.length, 0), 64 * 1024);
  assert.equal(result.data.messages[0].text.startsWith("[REDACTED]02"), true);
  assert.equal(result.data.messages.at(-1).text.startsWith("[REDACTED]09"), true);
  assert.equal(result.data.truncated, true);
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
  const stale = await owned.adapter.discoverOwned([ledgerRecord(launched)]);
  assert.equal(stale[0].status, "unknown");
  assert.equal(stale[0].discovery.confidence, "low");
  assert.equal(JSON.stringify(stale).includes(secret), false);
  assert.equal(observedCredential.every((byte) => byte === 0), true);

  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(
    owned.adapter.reconcileLaunch(ledgerRecord(launched), { signal: controller.signal }),
    (error) => error.code === "cursor_operation_cancelled" && !error.message.includes(secret),
  );
});

test("Cursor SDK launch sanitizes an abort racing with bridge rejection", async (t) => {
  const secret = "launch-abort-reason-secret";
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  let finishBridge;
  const bridgeFinished = new Promise((resolve) => { finishBridge = resolve; });
  const fixture = await makeFixture(t, {
    async createLocal() {
      lookupStarted();
      await bridgeFinished;
      throw new Error("bridge rejected after abort");
    },
  });
  const attemptId = `attempt:${uuidFor(940)}`;
  const launchId = `launch:${uuidFor(940)}`;
  const controller = new AbortController();
  const launch = fixture.adapter.launch(
    resolvedRequest(),
    { attemptId, launchId, signal: controller.signal },
  );
  await started;
  controller.abort(new Error(secret));
  finishBridge();

  await assert.rejects(
    launch,
    (error) => error.code === "cursor_operation_cancelled"
      && error.message === "Cursor SDK operation was cancelled"
      && !error.message.includes(secret)
      && !JSON.stringify(error).includes(secret),
  );
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records.find((record) => record.attemptId === attemptId)?.state, "intent");
  assert.equal(JSON.stringify(state).includes(secret), false);
});

test("Cursor SDK reconciliation sanitizes an abort racing with bridge rejection", async (t) => {
  const secret = "reconcile-abort-reason-secret";
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(
    resolvedRequest(),
    { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID },
  );
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  let finishBridge;
  const bridgeFinished = new Promise((resolve) => { finishBridge = resolve; });
  fixture.bridge.getLocal = async () => {
    lookupStarted();
    await bridgeFinished;
    throw new Error("bridge rejected after abort");
  };
  const controller = new AbortController();
  const reconciliation = fixture.adapter.reconcileLaunch(
    ledgerRecord(owned),
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error(secret));
  finishBridge();

  await assert.rejects(
    reconciliation,
    (error) => error.code === "cursor_operation_cancelled"
      && error.message === "Cursor SDK operation was cancelled"
      && !error.message.includes(secret)
      && !JSON.stringify(error).includes(secret),
  );
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(state.records.find((record) => record.attemptId === ATTEMPT_ID)?.state, "owned");
  assert.equal(JSON.stringify(state).includes(secret), false);
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

test("Cursor SDK rejects captured, mutated, and replayed credential errors", async (t) => {
  const secret = "cursor-replayed-secret";
  let replayed;
  let invocation = 0;
  const fixture = await makeFixture(t, {}, {
    credentialSource: createCursorSdkCredentialSource(() => {
      invocation += 1;
      if (invocation === 1) return "short";
      throw replayed;
    }),
  });

  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), {
      attemptId: `attempt:${uuidFor(930)}`,
      launchId: `launch:${uuidFor(930)}`,
    }),
    (error) => {
      replayed = error;
      return error.code === "cursor_credential_invalid"
        && error.message === "Cursor SDK credential source returned an invalid credential";
    },
  );
  replayed.code = "cursor_operation_cancelled";
  replayed.message = secret;

  await assert.rejects(
    fixture.adapter.launch(resolvedRequest(), {
      attemptId: `attempt:${uuidFor(931)}`,
      launchId: `launch:${uuidFor(931)}`,
    }),
    (error) => error !== replayed
      && error.code === "cursor_credential_unavailable"
      && error.message === "Cursor SDK credential source is unavailable"
      && !error.message.includes(secret),
  );
});

test("Cursor SDK does not consult Proxy properties when classifying external errors", async (t) => {
  const secret = "cursor-proxy-secret";
  let propertyReads = 0;
  const proxyError = () => new Proxy(new Error("untrusted"), {
    get(target, property, receiver) {
      propertyReads += 1;
      if (typeof property === "symbol") return true;
      if (property === "message" || property === "code") return secret;
      return Reflect.get(target, property, receiver);
    },
  });

  const callbackFixture = await makeFixture(t, {}, {
    credentialSource: createCursorSdkCredentialSource(() => { throw proxyError(); }),
  });
  await assert.rejects(
    callbackFixture.adapter.launch(resolvedRequest(), {
      attemptId: `attempt:${uuidFor(932)}`,
      launchId: `launch:${uuidFor(932)}`,
    }),
    (error) => error.code === "cursor_credential_unavailable"
      && error.message === "Cursor SDK credential source is unavailable"
      && !error.message.includes(secret),
  );
  assert.equal(propertyReads, 0);

  const bridgeFixture = await makeFixture(t, {
    async createLocal() { throw proxyError(); },
  }, { credentialSource: createCursorSdkCredentialSource("cursor-fixture-secret") });
  await assert.rejects(
    bridgeFixture.adapter.launch(resolvedRequest(), {
      attemptId: `attempt:${uuidFor(933)}`,
      launchId: `launch:${uuidFor(933)}`,
    }),
    (error) => error.code === "cursor_bridge_failed"
      && error.message === "Cursor SDK bridge createLocal failed"
      && !error.message.includes(secret),
  );
  assert.equal(propertyReads, 0);
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

test("Cursor SDK owned discovery sanitizes cancellation before mapping", async (t) => {
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  fixture.bridge.getLocal = async () => { throw new Error("synthetic bridge cancellation"); };
  const controller = new AbortController();
  const secret = "pre-mapper-abort-secret";
  controller.abort(new Error(secret));

  await assert.rejects(
    fixture.adapter.discoverOwned([ledgerRecord(owned)], { signal: controller.signal }),
    (error) => error.code === "cursor_operation_cancelled"
      && error.message === "Cursor SDK operation was cancelled"
      && !error.message.includes(secret)
      && !JSON.stringify(error).includes(secret),
  );
});

test("Cursor SDK owned discovery sanitizes cancellation during a lookup", async (t) => {
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
  const secret = "in-flight-abort-secret";
  const abortReason = new Error(secret);
  const discovery = fixture.adapter.discoverOwned([ledgerRecord(owned)], { signal: controller.signal });
  await started;
  controller.abort(abortReason);
  finishLookup();

  await assert.rejects(
    discovery,
    (error) => error !== abortReason
      && error.code === "cursor_operation_cancelled"
      && error.message === "Cursor SDK operation was cancelled"
      && !error.message.includes(secret)
      && !JSON.stringify(error).includes(secret),
  );
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
    privateState: fixtureFileSystem(provenanceDirectory),
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
    privateState: fixtureFileSystem(join(directory, "provenance")),
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
    privateState: fixtureFileSystem(dirname(first.provenanceFile)),
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
    privateStateFactory(directory) {
      const privateState = fixtureFileSystem(directory);
      const acquire = privateState.acquireWriterLock.bind(privateState);
      return {
        ...privateState,
        async acquireWriterLock(name) {
          acquisitions += 1;
          const lease = await acquire(name);
          if (acquisitions !== 1) return lease;
          return {
            ...lease,
            async release() {
              await lease.release();
              throw new Error("synthetic release failure");
            },
          };
        },
      };
    },
  });

  await assert.rejects(fixture.adapter.close(), /synthetic release failure/);
  await fixture.adapter.open();
  assert.equal(acquisitions, 2);
});

test("Cursor SDK initial-load cleanup retains only a still-held writer lease", async (t) => {
  await t.test("a pre-unlock failure is retained for retry and terminal backend cleanup", async (t) => {
    const fixture = await makeLeaseCleanupFixture(t, { failurePoint: "load", releaseFailure: "pre-unlock" });
    await assert.rejects(fixture.adapter.open(), (error) => error === fixture.cleanupError);
    await fixture.adapter.open();
    assert.equal(fixture.acquisitions(), 1);
    await assert.rejects(fixture.adapter.destroy(), /synthetic pre-unlock release failure/);
    assert.equal(fixture.releaseCalls(), 2);
    assert.equal(fixture.backendCloses(), 1);

    const replacement = new CursorSdkAdapter({
      bridge: fixture.bridge,
      credentialSource: fixtureCredentialSource(),
      sdkVersion: "1.0.28",
      storeDirectory: fixture.storeDirectory,
      provenanceFile: fixture.provenanceFile,
      targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
      privateState: fixtureFileSystem(fixture.privateDirectory),
    });
    await replacement.open();
    await replacement.destroy();
  });

  await t.test("a post-unlock failure clears the lease and reacquires on retry", async (t) => {
    const fixture = await makeLeaseCleanupFixture(t, { failurePoint: "load", releaseFailure: "post-unlock" });
    await assert.rejects(fixture.adapter.open(), (error) => error === fixture.cleanupError);
    await fixture.adapter.open();
    assert.equal(fixture.acquisitions(), 2);
    await fixture.adapter.destroy();
    assert.equal(fixture.releaseCalls(), 2);
    assert.equal(fixture.backendCloses(), 1);
  });
});

test("Cursor SDK post-acquire identity cleanup retains only a still-held writer lease", async (t) => {
  await t.test("a pre-unlock failure retains the lease for retry and terminal cleanup", async (t) => {
    const fixture = await makeLeaseCleanupFixture(t, { failurePoint: "assert", releaseFailure: "pre-unlock" });
    await assert.rejects(fixture.adapter.open(), (error) => error === fixture.cleanupError);
    await fixture.adapter.open();
    assert.equal(fixture.acquisitions(), 1);
    await assert.rejects(fixture.adapter.destroy(), /synthetic pre-unlock release failure/);
    assert.equal(fixture.releaseCalls(), 2);
    assert.equal(fixture.backendCloses(), 1);

    const replacement = new CursorSdkAdapter({
      bridge: fixture.bridge,
      credentialSource: fixtureCredentialSource(),
      sdkVersion: "1.0.28",
      storeDirectory: fixture.storeDirectory,
      provenanceFile: fixture.provenanceFile,
      targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
      privateState: fixtureFileSystem(fixture.privateDirectory),
    });
    await replacement.open();
    await replacement.destroy();
  });

  await t.test("a post-unlock failure clears the lease and reacquires on retry", async (t) => {
    const fixture = await makeLeaseCleanupFixture(t, { failurePoint: "assert", releaseFailure: "post-unlock" });
    await assert.rejects(fixture.adapter.open(), (error) => error === fixture.cleanupError);
    await fixture.adapter.open();
    assert.equal(fixture.acquisitions(), 2);
    await fixture.adapter.destroy();
    assert.equal(fixture.releaseCalls(), 2);
    assert.equal(fixture.backendCloses(), 1);
  });
});

test("Cursor SDK close releases only its lease and destroy terminates the injected backend", async (t) => {
  let backendCloses = 0;
  let backendDisposals = 0;
  const fixture = await makeFixture(t, {}, {
    privateStateFactory(directory) {
      return {
        ...fixtureFileSystem(directory),
        async close() { backendCloses += 1; },
        async dispose() { backendDisposals += 1; },
      };
    },
  });

  await fixture.adapter.close();
  assert.equal(backendCloses, 0);
  await fixture.adapter.open();
  await fixture.adapter.launch(resolvedRequest(), { attemptId: ATTEMPT_ID, launchId: LAUNCH_ID });
  await fixture.adapter.destroy();
  assert.equal(backendCloses, 0);
  assert.equal(backendDisposals, 1);
  await assert.rejects(fixture.adapter.open(), /destroyed/);
});

test("Cursor SDK terminal destroy abandons a lease after graceful release fails", async (t) => {
  let backendDisposals = 0;
  let underlyingLease;
  const fixture = await makeFixture(t, {}, {
    expectDestroyFailure: true,
    privateStateFactory(directory) {
      const privateState = fixtureFileSystem(directory);
      const acquire = privateState.acquireWriterLock.bind(privateState);
      return {
        ...privateState,
        async acquireWriterLock(name) {
          underlyingLease = await acquire(name);
          return {
            isHeld: () => underlyingLease.isHeld(),
            async release() { throw new Error("synthetic held-lease release failure"); },
          };
        },
        async dispose() {
          backendDisposals += 1;
          await underlyingLease.release();
          throw new Error("synthetic backend disposal failure");
        },
      };
    },
  });

  const first = fixture.adapter.destroy();
  const second = fixture.adapter.destroy();
  assert.equal(second, first);
  for (const disposal of [first, second]) {
    await assert.rejects(disposal, (error) => error instanceof AggregateError
      && error.errors.some((entry) => /held-lease release failure/.test(entry.message))
      && error.errors.some((entry) => /backend disposal failure/.test(entry.message)));
  }
  assert.equal(backendDisposals, 1);

  const replacement = new CursorSdkAdapter({
    bridge: fixture.bridge,
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: fixture.storeDirectory,
    provenanceFile: fixture.provenanceFile,
    targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
    privateState: fixtureFileSystem(dirname(fixture.provenanceFile)),
  });
  t.after(() => replacement.destroy());
  await replacement.open();
  await replacement.close();
});

test("Cursor SDK provenance retains its lease when release fails before unlocking", async (t) => {
  let acquisitions = 0;
  let releaseCalls = 0;
  const fixture = await makeFixture(t, {}, {
    privateStateFactory(directory) {
      const privateState = fixtureFileSystem(directory);
      const acquire = privateState.acquireWriterLock.bind(privateState);
      return {
        ...privateState,
        async acquireWriterLock(name) {
          acquisitions += 1;
          const lease = await acquire(name);
          return {
            ...lease,
            async release() {
              releaseCalls += 1;
              if (releaseCalls === 1) throw new Error("synthetic pre-unlock release failure");
              await lease.release();
            },
          };
        },
      };
    },
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
    privateState: fixtureFileSystem(dirname(first.provenanceFile)),
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
    privateState: fixtureFileSystem(privateDirectory),
  });
  assert.equal(adapter.launchCapabilities(), null);
  await assert.rejects(adapter.open(), /invalid Cursor SDK provenance state/);
  assert.equal(adapter.launchCapabilities(), null);
  assert.equal((await readFile(provenanceFile, "utf8")).includes("must-not-reset"), true);
});

test("Cursor SDK does not treat a post-read identity failure as missing provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-post-read-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeDirectory = join(directory, "sdk-store");
  const privateDirectory = join(directory, "private");
  await mkdir(cwd);
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(privateDirectory, { mode: 0o700 });
  const missing = Object.assign(new Error("provenance identity disappeared"), { code: "ENOENT" });
  let identityChecks = 0;
  const adapter = new CursorSdkAdapter({
    bridge: { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile: join(privateDirectory, "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    privateState: fixtureFileSystem(privateDirectory, {
      async readFileBounded() { return JSON.stringify({ schemaVersion: 1, records: [] }); },
      async assertCurrent() {
        identityChecks += 1;
        if (identityChecks === 3) throw missing;
      },
    }),
  });
  t.after(() => adapter.destroy());
  await assert.rejects(adapter.open(), (error) => error === missing);
  assert.equal(identityChecks, 3);
  assert.equal(adapter.launchCapabilities(), null);
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
    privateState: fixtureFileSystem(join(directory, "private"), {
      async readFileBounded() { throw missing; },
      async writeFileAtomic() { throw new Error("synthetic atomic write failure"); },
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
    privateState: fixtureFileSystem(dirname(fixture.provenanceFile)),
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

test("Cursor SDK retirement preparation rejects before the launch ledger can be fenced", async (t) => {
  let adapter;
  t.after(() => adapter?.close());
  const fixture = await makeFixture(t);
  const owned = await fixture.adapter.launch(resolvedRequest(), {
    attemptId: ATTEMPT_ID, launchId: LAUNCH_ID,
  });
  const state = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  const template = state.records[0];
  state.records = Array.from({ length: 1_000 }, (_, index) => {
    if (index === 0) return template;
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
  const targetBytes = 1_000_000 - 50;
  let padding = targetBytes - Buffer.byteLength(`${JSON.stringify(state)}\n`);
  const reserveRecord = state.records.at(-1);
  for (const record of state.records.slice(1, -1)) {
    for (const field of ["target", "profile", "sdkVersion", "bridgeNamespace"]) {
      const added = Math.min(100 - record[field].length, padding);
      record[field] += "x".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    if (padding === 0) break;
  }
  const reserveCapacity = ["target", "profile", "sdkVersion", "bridgeNamespace"]
    .reduce((total, field) => total + 100 - reserveRecord[field].length, 0);
  for (const record of state.records.slice(1, -1)) {
    if (padding <= reserveCapacity) break;
    const probe = { ...record, runId: "" };
    const overhead = Buffer.byteLength(JSON.stringify(probe))
      - Buffer.byteLength(JSON.stringify(record));
    const added = Math.min(200, Math.max(1, padding - reserveCapacity - overhead));
    record.runId = "r".repeat(added);
    padding -= overhead + added;
  }
  for (const field of ["target", "profile", "sdkVersion", "bridgeNamespace"]) {
    const added = Math.min(100 - reserveRecord[field].length, padding);
    reserveRecord[field] += "x".repeat(added);
    padding -= added;
  }
  assert.equal(padding, 0);
  assert.equal(Buffer.byteLength(`${JSON.stringify(state)}\n`), targetBytes);
  await fixture.adapter.close();
  await writeFile(fixture.provenanceFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  adapter = new CursorSdkAdapter({
    bridge: {
      namespace: "fixture", sdkVersion: "1.0.28",
      async createLocal() {}, async getLocal() { return null; }, async deleteLocal() {},
    },
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory: fixture.storeDirectory,
    provenanceFile: fixture.provenanceFile,
    targets: [{ id: "workspace-a", cwd: fixture.cwd, profiles: ["safe"] }],
    privateState: fixtureFileSystem(dirname(fixture.provenanceFile)),
  });
  await adapter.open();
  assert.deepEqual(await adapter.prepareLaunchRetirement(ledgerRecord(owned), {
    keyHash: "r".repeat(43),
  }), { status: "blocked", code: "cursor_provenance_capacity" });
  const persisted = JSON.parse(await readFile(fixture.provenanceFile, "utf8"));
  assert.equal(persisted.records[0].state, "owned");
  assert.equal(persisted.records[0].retirementKeyHash, undefined);
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
  const ledgerFile = join(fixture.directory, "launches.json");
  const logs = [];
  registry = new AgentRegistry([fixture.adapter]);
  coordinator = new LaunchCoordinator(registry, {
    ledgerFile,
    operations: {
      logger: { log(...entries) { logs.push(entries); } },
      metrics: { increment() {}, observe() {}, setGauge() {} },
    },
  });
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

async function makeLeaseCleanupFixture(t, { failurePoint, releaseFailure }) {
  const directory = await mkdtemp(join(tmpdir(), `agent-host-cursor-sdk-${failurePoint}-${releaseFailure}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const storeDirectory = join(directory, "sdk-store");
  const privateDirectory = join(directory, "private");
  await mkdir(cwd);
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(privateDirectory, { mode: 0o700 });
  const base = fixtureFileSystem(privateDirectory);
  const acquire = base.acquireWriterLock.bind(base);
  const read = base.readFileBounded.bind(base);
  const assertCurrent = base.assertCurrent.bind(base);
  const cleanupError = new Error(`synthetic ${failurePoint} cleanup failure`);
  let reads = 0;
  let identityChecks = 0;
  let acquisitions = 0;
  let releaseCalls = 0;
  let backendCloses = 0;
  let underlyingLease;
  const privateState = {
    ...base,
    async readFileBounded(name, maximumBytes) {
      reads += 1;
      if (failurePoint === "load" && reads === 1) throw cleanupError;
      return read(name, maximumBytes);
    },
    async assertCurrent() {
      identityChecks += 1;
      if (failurePoint === "assert" && identityChecks === 1) throw cleanupError;
      return assertCurrent();
    },
    async acquireWriterLock(name) {
      acquisitions += 1;
      underlyingLease = await acquire(name);
      return {
        isHeld: () => underlyingLease.isHeld(),
        async release() {
          releaseCalls += 1;
          if (releaseFailure === "pre-unlock") {
            throw new Error("synthetic pre-unlock release failure");
          }
          await underlyingLease.release();
          if (releaseCalls === 1) throw new Error("synthetic post-unlock release failure");
        },
      };
    },
    async close() {
      backendCloses += 1;
      if (underlyingLease?.isHeld()) await underlyingLease.release();
    },
  };
  const bridge = { namespace: "fixture", sdkVersion: "1.0.28", async createLocal() {}, async getLocal() {} };
  const options = {
    bridge,
    credentialSource: fixtureCredentialSource(),
    sdkVersion: "1.0.28",
    storeDirectory,
    provenanceFile: join(privateDirectory, "provenance.json"),
    targets: [{ id: "workspace-a", cwd, profiles: ["safe"] }],
    privateState,
  };
  return {
    adapter: new CursorSdkAdapter(options),
    bridge,
    cwd,
    storeDirectory,
    privateDirectory,
    provenanceFile: options.provenanceFile,
    cleanupError,
    acquisitions: () => acquisitions,
    releaseCalls: () => releaseCalls,
    backendCloses: () => backendCloses,
  };
}

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
  if (typeof bridgeOverrides.deleteLocal === "function") {
    bridge.deleteLocal = async (input) => {
      await input.onInvoke?.();
      return bridgeOverrides.deleteLocal(input);
    };
  }
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const storeDirectory = join(directory, "sdk-store");
  const provenanceFile = join(directory, "private", "cursor-sdk-provenance.json");
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(join(directory, "private"), { mode: 0o700 });
  const privateState = adapterOptions.privateState
    ?? adapterOptions.privateStateFactory?.(dirname(provenanceFile))
    ?? fixtureFileSystem(dirname(provenanceFile), adapterOptions.afterProvenanceWrite ? {
      async writeFileAtomic(name, contents) {
        await writePrivateFileAtomic(join(dirname(provenanceFile), name), contents);
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
    privateState,
  });
  await adapter.open();
  t.after(async () => {
    try { await adapter.destroy(); }
    catch (error) {
      if (!adapterOptions.expectDestroyFailure) throw error;
    }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { adapter, bridge, agents, cwd, directory, storeDirectory, provenanceFile };
}

function fixtureFileSystem(directory, overrides = {}) {
  directory = realpathSync(directory);
  const identity = lstatSync(directory);
  return {
    directory,
    identity: { dev: identity.dev, ino: identity.ino },
    async readFileBounded(name, maximumBytes) {
      return readPrivateFileBounded(join(directory, basename(name)), maximumBytes);
    },
    async writeFileAtomic(name, contents) {
      return writePrivateFileAtomic(join(directory, basename(name)), contents);
    },
    async acquireWriterLock(name) {
      const lease = await acquireInstanceLock(join(directory, basename(name)), { prepareDirectory: false });
      let held = true;
      return {
        async release() {
          if (!held) return;
          try { await lease.release(); }
          finally { held = false; }
        },
        isHeld() { return held; },
      };
    },
    async assertCurrent() {
      const current = await lstat(directory);
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory() || current.isSymbolicLink()) {
        throw new Error("Cursor SDK provenance changed after configuration");
      }
    },
    async close() {},
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
