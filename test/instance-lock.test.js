import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireInstanceLock, inspectInstanceLock } from "../src/instance-lock.js";

test("instance lock rejects a live duplicate and recovers a stale owner", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-lock-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const path = join(home, "state", "host.lock");
  const first = await acquireInstanceLock(path, { pid: 101, instanceId: "first", isProcessAlive: () => true });
  await assert.rejects(
    acquireInstanceLock(path, { pid: 202, instanceId: "second", isProcessAlive: () => true }),
    /already running with pid 101/,
  );
  await first.release();

  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, pid: 101, instanceId: "stale", startedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  const recovered = await acquireInstanceLock(path, { pid: 202, instanceId: "recovered", isProcessAlive: () => false });
  assert.equal(JSON.parse(await readFile(path, "utf8")).instanceId, "recovered");
  await recovered.release();
  assert.equal((await inspectInstanceLock(path)).state, "stopped");
});

test("lock release never removes a replacement file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-lock-replace-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const path = join(home, "host.lock");
  const lock = await acquireInstanceLock(path, { pid: 101, instanceId: "owner", isProcessAlive: () => true });
  await unlink(path);
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, pid: 202, instanceId: "replacement" })}\n`);
  await lock.release();
  assert.equal(JSON.parse(await readFile(path, "utf8")).instanceId, "replacement");
});

test("instance lock can require an already-prepared directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-lock-prepared-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const directory = join(home, "missing");
  await assert.rejects(
    acquireInstanceLock(join(directory, "host.lock"), { prepareDirectory: false }),
    { code: "ENOENT" },
  );
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});
