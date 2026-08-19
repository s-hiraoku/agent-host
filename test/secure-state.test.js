import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readOrCreateToken, readPrivateFile, readPrivateFileBufferBounded, readPrivateFileTail, rotateToken,
  readStrictPrivateFileBufferBounded,
} from "../src/secure-state.js";

test("token bootstrap and rotation are atomic and owner-only", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-token-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const tokenFile = join(home, "state", "token");
  const first = await readOrCreateToken(tokenFile);
  const second = await rotateToken(tokenFile);

  assert.equal(first.length, 43);
  assert.equal(second.length, 43);
  assert.notEqual(first, second);
  assert.equal((await readFile(tokenFile, "utf8")).trim(), second);
  assert.equal((await lstat(join(home, "state"))).mode & 0o777, 0o700);
  assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
});

test("token reader rejects symbolic links", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-token-link-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const target = join(home, "target");
  const link = join(home, "token");
  await writeFile(target, "secret\n");
  await symlink(target, link);
  await assert.rejects(readOrCreateToken(link), /regular file/);
  await assert.rejects(readPrivateFileTail(link, 16), /regular file/);
});

test("private file readers validate and tighten the opened file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-private-reader-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const path = join(home, "private.txt");
  await writeFile(path, "first\nsecond\n", { mode: 0o644 });

  assert.equal(await readPrivateFile(path), "first\nsecond\n");
  assert.deepEqual(await readPrivateFileBufferBounded(path, 20), Buffer.from("first\nsecond\n"));
  await assert.rejects(readPrivateFileBufferBounded(path, 3), /size limit/);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(await readPrivateFileTail(path, 8), "second\n");
});

test("token reader rejects an empty persistent token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-token-empty-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const tokenFile = join(home, "token");
  await writeFile(tokenFile, "\n", { mode: 0o600 });
  await assert.rejects(readOrCreateToken(tokenFile), /token file is empty/);
});

test("strict credential readers reject disclosed Bridge and API key files instead of repairing them", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-strict-credentials-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  for (const name of ["cursor-bridge.token", "cursor-api.key"]) {
    const path = join(home, name);
    await writeFile(path, "credential-value\n", { mode: 0o600 });
    await chmod(path, 0o640);
    await assert.rejects(readStrictPrivateFileBufferBounded(path, 100), /must not grant group or other access/);
    assert.equal((await lstat(path)).mode & 0o777, 0o640);
  }
});

test("secure state refuses to change permissions on an existing shared directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-shared-state-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const shared = join(home, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await assert.rejects(readOrCreateToken(join(shared, "token")), /must not grant group or other access/);
  assert.equal((await lstat(shared)).mode & 0o777, 0o755);
});
