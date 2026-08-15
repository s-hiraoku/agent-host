import {
  cp, lstat, mkdir, open, readFile, readdir, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const STATE_FILE = "install-state.json";

export async function installRelease({
  source, prefix, binDirectory, nodePath = process.execPath, beforeTransactionClear,
  beforeLockOwnerWrite, afterStaleOwnerRead, beforeStaleLockRename, afterStateRename,
}) {
  assertSupportedNode();
  source = resolve(source);
  prefix = resolve(prefix);
  binDirectory = resolve(binDirectory);
  await validateReleaseSource(source);
  const manifest = JSON.parse(await readFile(join(source, "release-compatibility.json"), "utf8"));
  const version = validVersion(manifest.productVersion);
  const releaseDirectory = join(prefix, "releases", version);
  return withInstallLock(prefix, async () => {
    await recoverTransaction({ prefix, binDirectory, nodePath });
    await prepareBinDirectory(binDirectory);
    const previousState = await readState(prefix);
    if (!previousState) {
      try {
        await lstat(join(prefix, "current"));
        throw new Error("install pointer exists without managed install state; refusing to replace it");
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await mkdir(join(prefix, "releases"), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(prefix);
    try { await lstat(releaseDirectory); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const staging = `${releaseDirectory}.staging-${randomUUID()}`;
      try {
        await cp(source, staging, { recursive: true, verbatimSymlinks: true });
        await validateReleaseSource(staging);
        await rename(staging, releaseDirectory);
        await syncDirectory(dirname(releaseDirectory));
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    await validateReleaseSource(releaseDirectory);
    const previous = previousState?.current && previousState.current !== version
      ? previousState.current
      : previousState?.previous;
    await writeTransaction(prefix, { schemaVersion: 1, from: previousState?.current ?? null, to: version });
    try {
      await switchCurrent(prefix, version);
      await writeLauncher({ prefix, binDirectory, nodePath });
      await writeState(prefix, { schemaVersion: 1, current: version, previous: previous ?? null }, afterStateRename);
    } catch (error) {
      try {
        await restorePrevious({ prefix, binDirectory, nodePath, previousState });
        await clearTransaction(prefix);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "release activation and automatic restoration failed; rerun the install command to recover the pending transaction");
      }
      throw error;
    }
    await beforeTransactionClear?.();
    await clearTransaction(prefix);
    return { installed: true, current: version, previous: previous ?? null, prefix };
  }, { beforeOwnerWrite: beforeLockOwnerWrite, afterStaleOwnerRead, beforeStaleLockRename });
}

export async function rollbackRelease({ prefix, binDirectory, nodePath = process.execPath, beforeTransactionClear, afterStateRename }) {
  assertSupportedNode();
  prefix = resolve(prefix);
  binDirectory = resolve(binDirectory);
  return withInstallLock(prefix, async () => {
    await recoverTransaction({ prefix, binDirectory, nodePath });
    await prepareBinDirectory(binDirectory);
    const state = await readState(prefix);
    if (!state?.previous) throw new Error("no previous agent-host release is available for rollback");
    const previousVersion = validVersion(state.previous);
    await validateReleaseSource(join(prefix, "releases", previousVersion));
    await writeTransaction(prefix, { schemaVersion: 1, from: state.current, to: previousVersion });
    try {
      await switchCurrent(prefix, previousVersion);
      await writeLauncher({ prefix, binDirectory, nodePath });
      await writeState(prefix, { schemaVersion: 1, current: previousVersion, previous: state.current }, afterStateRename);
    } catch (error) {
      try {
        await restorePrevious({ prefix, binDirectory, nodePath, previousState: state });
        await clearTransaction(prefix);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "rollback activation and automatic restoration failed; rerun rollback to recover the pending transaction");
      }
      throw error;
    }
    await beforeTransactionClear?.();
    await clearTransaction(prefix);
    return { rolledBack: true, current: previousVersion, previous: state.current, prefix };
  });
}

export async function uninstallRelease({ prefix, binDirectory }) {
  prefix = resolve(prefix);
  binDirectory = resolve(binDirectory);
  return withInstallLock(prefix, async () => {
    await recoverTransaction({ prefix, binDirectory, nodePath: process.execPath });
    const state = await readState(prefix);
    if (!state) return { removed: false, prefix };
    const launcher = join(binDirectory, "agent-host");
    try {
      const contents = await readFile(launcher, "utf8");
      if (contents.includes(join(prefix, "current", "src", "cli.js"))) await unlink(launcher);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rm(join(prefix, "releases"), { recursive: true, force: true });
    for (const path of [join(prefix, "current"), join(prefix, STATE_FILE), join(prefix, "install-transaction.json")]) {
      try { await unlink(path); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return { removed: true, prefix, preserved: ["~/.agent-host"] };
  });
}

export async function installationStatus(prefix) {
  const state = await readState(resolve(prefix));
  return state ? { installed: true, ...state } : { installed: false };
}

async function validateReleaseSource(source) {
  const root = await lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`release must be a real directory: ${source}`);
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(source, "release-compatibility.json"), "utf8"));
  validVersion(manifest.productVersion);
  if (packageJson.version !== manifest.productVersion) throw new Error("release package and compatibility versions do not match");
  if (!manifest.apiVersions?.includes("1") || !manifest.dashboard?.apiVersions?.includes("1")) {
    throw new Error("release dashboard is incompatible with agent-host API v1; install a compatible release");
  }
  await readFile(join(source, "dashboard", "index.html"));
  await rejectLinks(source, source);
  await verifyFileManifest(source);
}

async function rejectLinks(root, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`release contains a symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) await rejectLinks(root, path);
    else if (!stat.isFile()) throw new Error(`release contains an unsupported file type: ${relative(root, path)}`);
  }
}

async function verifyFileManifest(root) {
  const manifest = JSON.parse(await readFile(join(root, "release-files.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("invalid release file manifest");
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (expected.size !== manifest.files.length || [...expected.keys()].some((path) => typeof path !== "string")) {
    throw new Error("invalid release file manifest entries");
  }
  const actual = await releaseFiles(root);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    throw new Error("release contents do not match the file allowlist");
  }
  for (const path of actual) {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`invalid release path: ${path}`);
    const contents = await readFile(join(root, path));
    const entry = expected.get(path);
    const digest = createHash("sha256").update(contents).digest("hex");
    if (entry.bytes !== contents.length || entry.sha256 !== digest) throw new Error(`release file checksum mismatch: ${path}`);
  }
}

async function releaseFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await releaseFiles(root, path));
    else if (entry.isFile()) {
      const relativePath = relative(root, path);
      if (relativePath !== "release-files.json" && relativePath !== "sbom.spdx.json") result.push(relativePath);
    }
  }
  return result.sort();
}

async function switchCurrent(prefix, version) {
  version = validVersion(version);
  const current = join(prefix, "current");
  try {
    const stat = await lstat(current);
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace non-link install pointer: ${current}`);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const next = join(prefix, `.current-${randomUUID()}`);
  await symlink(join("releases", version), next);
  await syncDirectory(prefix);
  await rename(next, current);
  await syncDirectory(prefix);
}

async function writeLauncher({ prefix, binDirectory, nodePath }) {
  await prepareBinDirectory(binDirectory);
  const launcher = join(binDirectory, "agent-host");
  try {
    const stat = await lstat(launcher);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing to replace unsafe launcher: ${launcher}`);
    const existing = await readFile(launcher, "utf8");
    if (!existing.includes(join(prefix, "current", "src", "cli.js"))) {
      throw new Error(`refusing to replace unmanaged launcher: ${launcher}`);
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const script = `#!/bin/sh\nAGENT_HOST_LAUNCHER_PATH=${shellQuote(launcher)} exec ${shellQuote(nodePath)} ${shellQuote(join(prefix, "current", "src", "cli.js"))} "$@"\n`;
  await writeFileAtomic(launcher, script, 0o755);
}

async function prepareBinDirectory(binDirectory) {
  await mkdir(binDirectory, { recursive: true });
  const stat = await lstat(binDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`launcher directory must be a real directory: ${binDirectory}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`launcher directory must be owned by the current user: ${binDirectory}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`launcher directory must not be group/world writable: ${binDirectory}`);
}

async function writeState(prefix, state, afterRename) {
  await writeJsonAtomic(join(prefix, STATE_FILE), state, afterRename);
}

async function writeTransaction(prefix, transaction) {
  await writeJsonAtomic(join(prefix, "install-transaction.json"), transaction);
}

async function writeJsonAtomic(path, value, afterRename) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600, afterRename);
}

async function writeFileAtomic(path, contents, mode, afterRename) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(contents);
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(path));
    await rename(temporary, path);
    await afterRename?.();
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function clearTransaction(prefix) {
  try {
    await unlink(join(prefix, "install-transaction.json"));
    await syncDirectory(prefix);
  }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function recoverTransaction({ prefix, binDirectory, nodePath }) {
  let transaction;
  try { transaction = JSON.parse(await readFile(join(prefix, "install-transaction.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const state = await readState(prefix);
  const to = validVersion(transaction.to);
  const from = transaction.from === null ? null : validVersion(transaction.from);
  if (state?.current === to) {
    await validateRecoveryTarget(prefix, to);
    await switchCurrent(prefix, to);
    await writeLauncher({ prefix, binDirectory, nodePath });
  } else if (from) {
    await validateRecoveryTarget(prefix, from);
    await switchCurrent(prefix, from);
    await writeLauncher({ prefix, binDirectory, nodePath });
  } else {
    await removeCurrentAndLauncher(prefix, binDirectory);
  }
  await clearTransaction(prefix);
}

async function validateRecoveryTarget(prefix, version) {
  try {
    await validateReleaseSource(join(prefix, "releases", version));
  } catch (error) {
    throw new Error(`cannot recover install transaction because release ${version} is unavailable or invalid`, { cause: error });
  }
}

async function restorePrevious({ prefix, binDirectory, nodePath, previousState }) {
  if (previousState?.current) {
    await writeState(prefix, previousState);
    await switchCurrent(prefix, previousState.current);
    await writeLauncher({ prefix, binDirectory, nodePath });
  } else {
    try { await unlink(join(prefix, STATE_FILE)); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await removeCurrentAndLauncher(prefix, binDirectory);
  }
}

async function removeCurrentAndLauncher(prefix, binDirectory) {
  const current = join(prefix, "current");
  try { await unlink(current); }
  catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error; }
  const launcher = join(binDirectory, "agent-host");
  try {
    const contents = await readFile(launcher, "utf8");
    if (contents.includes(join(prefix, "current", "src", "cli.js"))) await unlink(launcher);
  } catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && error?.code !== "EISDIR") throw error; }
}

async function readState(prefix) {
  try {
    const state = JSON.parse(await readFile(join(prefix, STATE_FILE), "utf8"));
    if (state.schemaVersion !== 1) throw new Error("unsupported install state schema");
    validVersion(state.current);
    if (state.previous !== null) validVersion(state.previous);
    return state;
  }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function withInstallLock(prefix, callback, lockHooks) {
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(prefix);
  const lock = join(prefix, ".install-lock");
  const ownership = await acquireInstallLock(lock, lockHooks);
  try { return await callback(); }
  finally {
    await unlinkOwnedLock(lock, ownership.identity);
  }
}

async function acquireInstallLock(path, hooks = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
    const identity = await lstat(path);
    try {
      await hooks.beforeOwnerWrite?.();
      await writeFile(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await unlinkOwnedLock(path, identity);
      throw error;
    }
    return { identity };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let inspected;
    try { inspected = await lstat(path); }
    catch (inspectionError) {
      if (inspectionError?.code === "ENOENT") return acquireInstallLock(path, hooks);
      throw inspectionError;
    }
    let record;
    try { record = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); }
    catch (ownerError) {
      if (ownerError?.code === "ENOENT") {
        try {
          const current = await lstat(path);
          if (!sameIdentity(inspected, current)) return acquireInstallLock(path, hooks);
        } catch (inspectionError) {
          if (inspectionError?.code === "ENOENT") return acquireInstallLock(path, hooks);
          throw inspectionError;
        }
      }
      throw new Error("install lock is incomplete or malformed; verify no installer is running before removing it");
    }
    await hooks.afterStaleOwnerRead?.();
    let staleStat;
    try { staleStat = await lstat(path); }
    catch (inspectionError) {
      if (inspectionError?.code === "ENOENT") return acquireInstallLock(path, hooks);
      throw inspectionError;
    }
    if (!sameIdentity(inspected, staleStat)) return acquireInstallLock(path, hooks);
    if (!Number.isInteger(record?.pid) || record.pid <= 0 || !Number.isFinite(Date.parse(record.startedAt))) {
      throw new Error("install lock is incomplete or malformed; verify no installer is running before removing it");
    }
    if (processAlive(record.pid)) {
      throw new Error("another agent-host install, update, or rollback is in progress");
    }
    const quarantine = `${path}.stale-${staleStat.dev}-${staleStat.ino}`;
    await hooks.beforeStaleLockRename?.();
    try { await rename(path, quarantine); }
    catch (takeoverError) {
      if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(takeoverError?.code)) {
        try {
          const current = await lstat(path);
          if (sameIdentity(staleStat, current)) {
            throw new Error("another agent-host process acquired the stale install lock");
          }
        } catch (inspectionError) {
          if (inspectionError?.code !== "ENOENT") throw inspectionError;
        }
        return acquireInstallLock(path, hooks);
      }
      throw takeoverError;
    }
    const quarantineIdentity = await lstat(quarantine);
    if (!sameIdentity(staleStat, quarantineIdentity)) {
      throw new Error("install lock changed during stale takeover; verify no installer is running");
    }
    return acquireInstallLock(path, hooks);
  }
}

async function unlinkOwnedLock(path, identity) {
  try {
    const current = await lstat(path);
    if (sameIdentity(identity, current)) await rm(path, { recursive: true });
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function assertPrivateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`install path must be a real directory: ${path}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`install path must be owned by the current user: ${path}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`install path must not be group/world writable: ${path}`);
}

function assertSupportedNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22 || major >= 25) throw new Error(`Node ${process.version} is unsupported; install Node 22, 23, or 24`);
}

function validVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`invalid release version: ${value}`);
  }
  return value;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
