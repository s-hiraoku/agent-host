import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openAnchoredPrivateState } from "../src/anchored-private-state.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
let suiteDirectory;
let helperPath;

before(async () => {
  suiteDirectory = await realpath(await mkdtemp(join(tmpdir(), "agent-host-anchored-state-tests-")));
  helperPath = join(suiteDirectory, "anchored-private-state");
  await promisify(execFile)(process.execPath, [
    join(repository, "scripts", "build-anchored-private-state-helper.js"), helperPath,
  ]);
});

after(async () => {
  await rm(suiteDirectory, { recursive: true, force: true });
});

test("anchored private state atomically writes and bounds owner-only regular files", async (t) => {
  const { directory, state } = await fixture(t, { maxBytes: 32 });
  await state.writeFileAtomic("provenance.json", "hello");
  assert.equal(await state.readFileBounded("provenance.json", 32), "hello");
  assert.equal((await lstat(join(directory, "provenance.json"))).mode & 0o777, 0o600);
  await assert.rejects(state.readFileBounded("provenance.json", 4), /size limit/);
  await assert.rejects(state.writeFileAtomic("large", "x".repeat(33)), /size limit/);
  assert.deepEqual(await readFile(join(directory, "provenance.json"), "utf8"), "hello");
});

test("anchored private state accepts basenames only", async (t) => {
  const { state } = await fixture(t);
  for (const name of ["", ".", "..", "/absolute", "child/file", "nul\0name"]) {
    await assert.rejects(state.readFileBounded(name, 10), /basename/);
    await assert.rejects(state.writeFileAtomic(name, "x"), /basename/);
    await assert.rejects(state.acquireWriterLock(name), /basename/);
  }
});

test("anchored private state rejects symlinks and unsafe file permissions", async (t) => {
  const { directory, state } = await fixture(t);
  await writeFile(join(directory, "target"), "secret", { mode: 0o600 });
  await symlink("target", join(directory, "linked"));
  await assert.rejects(state.readFileBounded("linked", 100), /cannot open private state|regular file/);
  await assert.rejects(state.writeFileAtomic("linked", "replacement"), /owner-only regular file/);
  await writeFile(join(directory, "public"), "unsafe", { mode: 0o644 });
  await assert.rejects(state.readFileBounded("public", 100), /owner-only regular file/);
});

test("directory replacement receives no descriptor-relative write or lock mutation", async (t) => {
  const { directory, state } = await fixture(t);
  const captured = `${directory}-captured`;
  await rename(directory, captured);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(captured, { recursive: true, force: true }));
  await state.writeFileAtomic("provenance.json", "captured");
  const lease = await state.acquireWriterLock("writer.lock");
  await lease.release();
  assert.equal(await readFile(join(captured, "provenance.json"), "utf8"), "captured");
  await assert.rejects(readFile(join(directory, "provenance.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(directory, "writer.lock")), { code: "ENOENT" });
});

test("writer locks serialize helpers and release never unlinks a replacement", async (t) => {
  const { directory, state } = await fixture(t);
  const second = await openAnchoredPrivateState(directory, { helperPath });
  t.after(() => second.close());
  const firstLease = await state.acquireWriterLock("writer.lock");
  await assert.rejects(second.acquireWriterLock("writer.lock"), /already held/);
  await rename(join(directory, "writer.lock"), join(directory, "held.lock"));
  await writeFile(join(directory, "writer.lock"), "replacement", { mode: 0o600 });
  await assert.rejects(second.acquireWriterLock("writer.lock"), /already held/);
  await firstLease.release();
  assert.equal(await readFile(join(directory, "writer.lock"), "utf8"), "replacement");
  const secondLease = await second.acquireWriterLock("writer.lock");
  await secondLease.release();
});

test("opening rejects non-canonical, linked, or accessible directories and mutable helpers", async (t) => {
  const ordinary = await realpath(await mkdtemp(join(tmpdir(), "agent-host-anchored-input-")));
  t.after(() => rm(ordinary, { recursive: true, force: true }));
  await chmod(ordinary, 0o755);
  await assert.rejects(openAnchoredPrivateState(ordinary, { helperPath }), /group or other access/);
  await chmod(ordinary, 0o700);
  const linked = `${ordinary}-link`;
  await symlink(ordinary, linked);
  t.after(() => rm(linked, { force: true }));
  await assert.rejects(openAnchoredPrivateState(linked, { helperPath }), /real directory/);
  await chmod(helperPath, 0o700);
  await assert.rejects(openAnchoredPrivateState(ordinary, { helperPath }), /non-writable regular file/);
  await chmod(helperPath, 0o500);
  const linkedHelper = join(ordinary, "linked-helper");
  await symlink(helperPath, linkedHelper);
  await assert.rejects(openAnchoredPrivateState(ordinary, { helperPath: linkedHelper }), /must not be a symlink/);
  const localHelper = join(ordinary, "local-helper");
  await promisify(execFile)(process.execPath, [
    join(repository, "scripts", "build-anchored-private-state-helper.js"), localHelper,
  ]);
  const state = await openAnchoredPrivateState(ordinary, { helperPath: localHelper });
  t.after(() => state.close());
  await rename(localHelper, `${localHelper}-replaced`);
  await assert.rejects(state.readFileBounded("state", 10), /helper changed after opening/);
});

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-host-anchored-state-")));
  await chmod(directory, 0o700);
  const state = await openAnchoredPrivateState(directory, { helperPath, ...options });
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, state };
}
