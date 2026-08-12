import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOrCreateToken, rotateToken } from "../src/secure-state.js";

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
});

test("token reader rejects an empty persistent token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-token-empty-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const tokenFile = join(home, "token");
  await writeFile(tokenFile, "\n", { mode: 0o600 });
  await assert.rejects(readOrCreateToken(tokenFile), /token file is empty/);
});
