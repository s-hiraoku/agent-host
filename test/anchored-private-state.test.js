import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openAnchoredPrivateState } from "../src/anchored-private-state.js";
import { CursorSdkAdapter, createCursorSdkCredentialSource } from "../src/adapters/cursor-sdk.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const privilegedDirectory = process.env.AGENT_HOST_PRIVILEGED_STATE_DIR;
const privilegedHelper = process.env.AGENT_HOST_PRIVILEGED_STATE_HELPER;
const privileged = Boolean(privilegedDirectory && privilegedHelper);
let localDirectory;
let localHelper;

before(async () => {
  localDirectory = await realpath(await mkdtemp(join(tmpdir(), "agent-host-anchored-negative-")));
  localHelper = join(localDirectory, "anchored-private-state");
  await promisify(execFile)(process.execPath, [join(repository, "scripts", "build-anchored-private-state-helper.js"), localHelper]);
});

after(async () => { await rm(localDirectory, { recursive: true, force: true }); });

test("production backend rejects root execution or unprivileged paths", async () => {
  const expected = process.geteuid() === 0 ? /rejects root execution/ : /root-owned|ancestor/;
  await assert.rejects(openAnchoredPrivateState(localDirectory, { helperPath: localHelper }), expected);
});

test("persistent anchored private-state integration", { skip: !privileged }, async (t) => {
  await t.test("helper rejects root execution", async () => {
    await assert.rejects(promisify(execFile)("sudo", ["-n", privilegedHelper, "serve", privilegedDirectory]),
      (error) => error?.code !== 0
        && /anchored-private-state: root execution is unsupported for the same-UID threat model/.test(error.stderr));
  });

  await t.test("trusted helper still rejects a state directory below a writable ancestor", async () => {
    await assert.rejects(openAnchoredPrivateState(localDirectory, { helperPath: privilegedHelper }), /state directory ancestor/);
  });

  await t.test("one session owns bounded IO and supports lease close/open", async () => {
    const state = await productionState({ maxBytes: 32 });
    let lease = await state.acquireWriterLock("basic.lock");
    await state.writeFileAtomic("basic.json", "hello");
    assert.equal(await state.readFileBounded("basic.json", 32), "hello");
    await assert.rejects(state.writeFileAtomic("basic-large.json", "x".repeat(33)), /size limit/);
    await assert.rejects(state.writeFileAtomic(".agent-host-reserved.tmp", "x"), /reserved/);
    assert.equal(lease.isHeld(), true);
    await lease.release();
    lease = await state.acquireWriterLock("basic.lock");
    assert.equal(await state.readFileBounded("basic.json", 32), "hello");
    await lease.release();
    await state.dispose();
  });

  await t.test("clean helper exit leaves no bounded-exit timer referenced", async () => {
    const timeoutCount = () => process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
    const before = timeoutCount();
    const state = await productionState();
    const lease = await state.acquireWriterLock("timer-cleanup.lock");
    await lease.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timeoutCount() <= before, "bounded-exit timers are cleared after helper termination");
    await state.dispose();
  });

  await t.test("terminal disposal abandons an in-flight acquisition before it can publish", async () => {
    let acquisitionEntered;
    let continueAcquisition;
    const entered = new Promise((resolve) => { acquisitionEntered = resolve; });
    const continuation = new Promise((resolve) => { continueAcquisition = resolve; });
    const state = await productionState({
      async afterAcquireForTest() {
        acquisitionEntered();
        await continuation;
      },
    });
    const acquiring = state.acquireWriterLock("dispose-race.lock");
    const rejected = assert.rejects(acquiring, /disposed/);
    await entered;
    await assert.rejects(state.acquireWriterLock("dispose-race.lock"),
      (error) => error.code === "instance_already_running");
    const firstDisposal = state.dispose();
    const secondDisposal = state.dispose();
    assert.equal(secondDisposal, firstDisposal);
    continueAcquisition();
    await rejected;
    await firstDisposal;
    await assert.rejects(state.acquireWriterLock("dispose-race.lock"), /disposed/);

    const replacement = await productionState();
    const lease = await replacement.acquireWriterLock("dispose-race.lock");
    assert.equal(lease.isHeld(), true);
    await lease.release();
    await replacement.dispose();
  });

  await t.test("real backend supports adapter close, reopen, launch, and reconcile", async () => {
    const workspace = join(privilegedDirectory, "lifecycle-workspace");
    const storeDirectory = join(privilegedDirectory, "lifecycle-store");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(storeDirectory, { mode: 0o700 });
    const agents = new Map();
    const bridge = {
      namespace: "privileged-fixture",
      sdkVersion: "1.0.28",
      async createLocal(input) {
        const agent = { agentId: input.agentId, status: "idle" };
        agents.set(input.agentId, agent);
        return agent;
      },
      async getLocal({ agentId }) { return agents.get(agentId) ?? null; },
    };
    const privateState = await productionState();
    const adapter = new CursorSdkAdapter({
      bridge,
      credentialSource: createCursorSdkCredentialSource("privileged-fixture-secret"),
      sdkVersion: "1.0.28",
      storeDirectory,
      provenanceFile: join(privilegedDirectory, "lifecycle-provenance.json"),
      targets: [{ id: "workspace-a", cwd: workspace, profiles: ["safe"] }],
      privateState,
    });
    const request = {
      provider: "cursor",
      target: "workspace-a",
      profile: "safe",
      mode: "local",
      capabilityVersion: "cursor-sdk-local-1.0.28",
      risk: { localMutation: true, externalBillable: true },
    };
    const attemptId = "attempt:00000000-0000-4000-8000-000000000046";
    const launchId = "launch:00000000-0000-4000-8000-000000000046";
    await adapter.open();
    await adapter.close();
    await adapter.open();
    const owned = await adapter.launch(request, { attemptId, launchId });
    await adapter.close();
    await adapter.open();
    assert.deepEqual(await adapter.reconcileLaunch({
      id: launchId,
      attemptId,
      state: "owned",
      agentId: owned.agentId,
      providerAgentId: owned.providerAgentId,
      request,
    }), owned);
    await adapter.destroy();
    await assert.rejects(adapter.open(), /destroyed/);
  });

  await t.test("directory flock serializes sessions and maps contention", async () => {
    const first = await productionState();
    const second = await productionState();
    const firstLease = await first.acquireWriterLock("contention.lock");
    await assert.rejects(second.acquireWriterLock("contention.lock"), (error) => error.code === "instance_already_running");
    await firstLease.release();
    const secondLease = await second.acquireWriterLock("contention.lock");
    await secondLease.release();
  });

  await t.test("symlink, hardlink, FIFO, and hard-linked metadata fail closed", async () => {
    await writeFile(join(privilegedDirectory, "special-target"), "secret", { mode: 0o600 });
    await symlink("special-target", join(privilegedDirectory, "special-symlink"));
    let state = await productionState();
    let lease = await state.acquireWriterLock("special-symlink.lock");
    await assert.rejects(state.readFileBounded("special-symlink", 100), /unexpectedly/);
    assert.equal(lease.isHeld(), false);

    await link(join(privilegedDirectory, "special-target"), join(privilegedDirectory, "special-hardlink"));
    state = await productionState();
    lease = await state.acquireWriterLock("special-hardlink.lock");
    await assert.rejects(state.readFileBounded("special-hardlink", 100), /unexpectedly/);
    assert.equal(await readFile(join(privilegedDirectory, "special-target"), "utf8"), "secret");

    await promisify(execFile)("mkfifo", [join(privilegedDirectory, "special-fifo")]);
    state = await productionState();
    lease = await state.acquireWriterLock("special-fifo.lock");
    await assert.rejects(state.writeFileAtomic("special-fifo", "replacement"), /unexpectedly/);

    await writeFile(join(privilegedDirectory, "hardlock-target"), "durable", { mode: 0o600 });
    await link(join(privilegedDirectory, "hardlock-target"), join(privilegedDirectory, "hardlink.lock"));
    state = await productionState();
    await assert.rejects(state.acquireWriterLock("hardlink.lock"), /unexpectedly/);
    assert.equal(await readFile(join(privilegedDirectory, "hardlock-target"), "utf8"), "durable");
  });

  await t.test("helper death permanently poisons an acquired session", async () => {
    const state = await productionState();
    const lease = await state.acquireWriterLock("death.lock");
    const metadata = await readFile(join(privilegedDirectory, "death.lock"), "utf8");
    const helperPid = Number(/^helper_pid=(\d+)$/m.exec(metadata)?.[1]);
    assert.ok(Number.isInteger(helperPid) && helperPid > 1, "helper metadata contains a safe process id");
    process.kill(helperPid, "SIGKILL");
    await waitFor(() => !lease.isHeld());
    await assert.rejects(state.assertCurrent(), /poisoned/);
    await assert.rejects(state.writeFileAtomic("death.json", "must-not-run"), /poisoned/);
    await assert.rejects(lease.release(), /unexpectedly/);
    await assert.rejects(state.acquireWriterLock("death.lock"), /poisoned/);
  });

  await t.test("helper death while a large request is flushing cannot crash or retry", async () => {
    const state = await productionState();
    const lease = await state.acquireWriterLock("input-death.lock");
    await state.writeFileAtomic("input-death.json", "original");
    const metadata = await readFile(join(privilegedDirectory, "input-death.lock"), "utf8");
    const helperPid = Number(/^helper_pid=(\d+)$/m.exec(metadata)?.[1]);
    assert.ok(Number.isInteger(helperPid) && helperPid > 1, "helper metadata contains a safe process id");
    process.kill(helperPid, "SIGSTOP");
    const writing = state.writeFileAtomic("input-death.json", Buffer.alloc(1_000_000, 0x78));
    await delay(20);
    process.kill(helperPid, "SIGKILL");
    await assert.rejects(writing, /helper (?:input failed|exited unexpectedly)/);
    await waitFor(() => !lease.isHeld());
    assert.equal(await readFile(join(privilegedDirectory, "input-death.json"), "utf8"), "original");
    await assert.rejects(state.assertCurrent(), /poisoned/);
    await assert.rejects(lease.release(), /helper (?:input failed|exited unexpectedly)/);
  });

  await t.test("SIGKILL during streamed mutation preserves old value and next writer recovers temp", async () => {
    let state = await productionState();
    let lease = await state.acquireWriterLock("crash-seed.lock");
    await state.writeFileAtomic("crash.json", "original");
    await lease.release();

    const child = rawHelper();
    child.stdin.write(frame(1, 1, "crash-writer.lock"));
    assert.equal((await response(child)).error, 0);
    const header = frame(3, 2, "crash.json", ".agent-host-crash.tmp", 1_000_000, 1_000_000, false);
    child.stdin.write(Buffer.concat([header, Buffer.alloc(32_768, 0x78)]));
    await waitFor(async () => (await readdir(privilegedDirectory)).includes(".agent-host-crash.tmp"));
    child.kill("SIGKILL");
    await childExit(child);

    state = await productionState();
    lease = await state.acquireWriterLock("crash-recovery.lock");
    assert.equal(await state.readFileBounded("crash.json", 100), "original");
    assert.equal((await readdir(privilegedDirectory)).includes(".agent-host-crash.tmp"), false);
    await state.writeFileAtomic("crash.json", "recovered");
    assert.equal(await state.readFileBounded("crash.json", 100), "recovered");
    await lease.release();
  });

  await t.test("malformed and oversized frames terminate without a response", async () => {
    let child = rawHelper();
    child.stdin.end(Buffer.alloc(32, 0xff));
    assert.notEqual((await childExit(child)).code, 0);
    child = rawHelper();
    const oversized = frame(1, 1, "oversized.lock");
    oversized.writeUInt32BE(1_000_001, 20);
    child.stdin.end(oversized);
    assert.notEqual((await childExit(child)).code, 0);
  });

  await t.test("protected parent denies pathname replacement", async () => {
    await assert.rejects(rename(privilegedDirectory, `${privilegedDirectory}-replacement`),
      (error) => ["EACCES", "EPERM"].includes(error.code));
    assert.equal((await lstat(privilegedDirectory)).isDirectory(), true);
  });
});

async function productionState(options = {}) {
  return openAnchoredPrivateState(privilegedDirectory, { helperPath: privilegedHelper, ...options });
}

function rawHelper() {
  const child = spawn(privilegedHelper, ["serve", privilegedDirectory], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  return child;
}

function frame(operation, request, name = "", auxiliary = "", payloadLength = 0, limit = 0, includePayload = true) {
  const nameBytes = Buffer.from(name, "ascii");
  const auxiliaryBytes = Buffer.from(auxiliary, "ascii");
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x41485053, 0);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(operation, 6);
  header.writeUInt32BE(request, 8);
  header.writeUInt32BE(nameBytes.length, 12);
  header.writeUInt32BE(auxiliaryBytes.length, 16);
  header.writeUInt32BE(payloadLength, 20);
  header.writeUInt32BE(limit, 24);
  return Buffer.concat([header, nameBytes, auxiliaryBytes, includePayload ? Buffer.alloc(payloadLength) : Buffer.alloc(0)]);
}

async function response(child) {
  const header = await readBytes(child.stdout, 32);
  const length = header.readUInt32BE(20);
  return { error: header.readUInt32BE(24), payload: await readBytes(child.stdout, length) };
}

async function readBytes(stream, length) {
  if (length === 0) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (total < length) {
    const chunk = stream.read(length - total);
    if (chunk) { chunks.push(chunk); total += chunk.length; continue; }
    if (stream.readableEnded) throw new Error("helper exited before a complete response");
    await Promise.race([once(stream, "readable"), once(stream, "end")]);
  }
  return Buffer.concat(chunks);
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error("condition was not met before timeout");
}
