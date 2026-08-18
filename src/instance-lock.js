import { lstat, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDirectory } from "./secure-state.js";

export class InstanceAlreadyRunningError extends Error {
  constructor(path, pid) {
    super(`agent-host is already running with pid ${pid}; lock: ${path}`);
    this.name = "InstanceAlreadyRunningError";
    this.code = "instance_already_running";
    this.pid = pid;
  }
}

export async function acquireInstanceLock(path, options = {}) {
  if (options.prepareDirectory !== false) await ensurePrivateDirectory(dirname(path));
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomUUID();
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      const record = {
        schemaVersion: 1,
        pid,
        instanceId,
        startedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      const stat = await handle.stat();
      await handle.close();
      return {
        path,
        record,
        async release() { await releaseOwnedLock(path, record, stat); },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const inspected = await inspectInstanceLock(path, { isProcessAlive });
      if (inspected.state === "running") throw new InstanceAlreadyRunningError(path, inspected.record.pid);
      if (inspected.state !== "stale") {
        throw new Error(`agent-host lock is ${inspected.state}; refusing to replace it: ${path}`);
      }
      const current = await lstat(path);
      if (!sameFile(current, inspected.stat)) throw new Error(`agent-host lock changed during stale recovery: ${path}`);
      await unlink(path);
    }
  }
  throw new Error(`could not acquire agent-host lock: ${path}`);
}

export async function inspectInstanceLock(path, options = {}) {
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return { state: "stopped", path };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: "unsafe", path, stat };
  if (process.getuid && stat.uid !== process.getuid()) return { state: "foreign", path, stat };
  let record;
  try { record = JSON.parse(await readFile(path, "utf8")); }
  catch { return { state: "invalid", path, stat }; }
  if (record?.schemaVersion !== 1 || !Number.isInteger(record.pid) || record.pid <= 0
    || typeof record.instanceId !== "string" || !record.instanceId) {
    return { state: "invalid", path, stat, record };
  }
  return { state: isProcessAlive(record.pid) ? "running" : "stale", path, stat, record };
}

async function releaseOwnedLock(path, record, originalStat) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sameFile(stat, originalStat) || !stat.isFile() || stat.isSymbolicLink()) return;
  let current;
  try { current = JSON.parse(await readFile(path, "utf8")); }
  catch { return; }
  if (current.instanceId === record.instanceId && current.pid === record.pid) await unlink(path);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
