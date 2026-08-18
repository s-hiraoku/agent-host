import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const DEFAULT_MAX_BYTES = 1_000_000;

export async function openAnchoredPrivateState(directory, options = {}) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(`anchored private state is unsupported on ${process.platform}`);
  }
  const helper = await validateHelper(options.helperPath);
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new TypeError("anchored private-state directory must be an absolute path");
  }
  const configured = resolve(directory);
  const before = await lstat(configured);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("anchored private state requires a real directory");
  assertPrivate(before, "anchored private-state directory");
  const canonical = await realpath(configured);
  if (canonical !== configured) throw new Error("anchored private-state directory must be canonical");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryFlag = constants.O_DIRECTORY ?? 0;
  const handle = await open(canonical, constants.O_RDONLY | directoryFlag | noFollow);
  try {
    const identity = await handle.stat();
    assertPrivate(identity, "anchored private-state directory");
    if (!identity.isDirectory() || !sameIdentity(before, identity)) {
      throw new Error("anchored private-state directory changed while opening");
    }
    return new AnchoredPrivateState(canonical, identity, handle, helper, options.maxBytes);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

class AnchoredPrivateState {
  #handle;
  #helper;
  #maxBytes;
  #closed = false;
  #leases = new Set();
  #leaseFailure;

  constructor(directory, identity, handle, helper, maxBytes = DEFAULT_MAX_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
    this.directory = directory;
    this.identity = Object.freeze({ dev: identity.dev, ino: identity.ino });
    this.#handle = handle;
    this.#helper = helper;
    this.#maxBytes = maxBytes;
  }

  async readFileBounded(name, maximumBytes) {
    this.#assertOpen();
    validateName(name);
    const limit = this.#limit(maximumBytes);
    const result = await this.#run(["read", name, String(limit)]);
    return result.toString("utf8");
  }

  async writeFileAtomic(name, contents) {
    this.#assertOpen();
    validateName(name);
    if (typeof contents !== "string" && !Buffer.isBuffer(contents)) throw new TypeError("private state must be a string or Buffer");
    const input = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    if (input.length > this.#maxBytes) throw new Error("private state exceeds its size limit");
    const temporary = `.agent-host-${randomUUID()}.tmp`;
    await this.#run(["write", name, temporary, String(this.#maxBytes)], input);
  }

  async acquireWriterLock(name) {
    this.#assertOpen();
    validateName(name);
    await this.assertCurrent();
    const child = this.#spawn(["lock", name]);
    const tracked = trackChild(child);
    const ready = await waitForReady(child, tracked);
    if (!ready) throw new Error("anchored writer lock did not become ready");
    try {
      await this.assertCurrent();
    } catch (error) {
      if (!child.stdin.destroyed) child.stdin.end();
      await tracked.result;
      throw error;
    }
    let released = false;
    const record = {
      invalid: undefined,
      release: async () => {
        if (released) return;
        released = true;
        this.#leases.delete(record);
        if (!child.stdin.destroyed) child.stdin.end();
        const outcome = await tracked.result;
        if (outcome.error || outcome.code !== 0) throw childExitError(outcome, tracked.stderr());
      },
    };
    this.#leases.add(record);
    void tracked.result.then((outcome) => {
      if (!released) {
        record.invalid = childExitError(outcome, tracked.stderr());
        this.#leaseFailure ??= record.invalid;
      }
    });
    return { release: record.release };
  }

  async assertCurrent() {
    this.#assertOpen();
    if (this.#leaseFailure) throw new Error("anchored writer lock was lost", { cause: this.#leaseFailure });
    for (const lease of this.#leases) {
      if (lease.invalid) throw new Error("anchored writer lock was lost", { cause: lease.invalid });
    }
    const state = await this.#handle.stat();
    if (!state.isDirectory() || !sameIdentity(state, this.identity)) {
      throw new Error("anchored private-state directory descriptor changed");
    }
    assertPrivate(state, "anchored private-state directory");
    let pathname;
    try { pathname = await lstat(this.directory); }
    catch (error) {
      throw new Error("anchored private-state directory pathname changed", { cause: error });
    }
    if (!pathname.isDirectory() || pathname.isSymbolicLink() || !sameIdentity(pathname, this.identity)) {
      throw new Error("anchored private-state directory pathname changed");
    }
    assertPrivate(pathname, "anchored private-state directory");
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#leases].map((lease) => lease.release()));
    await this.#handle.close();
  }

  #limit(value) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError("maximumBytes must be a positive integer");
    return Math.min(value, this.#maxBytes);
  }

  #assertOpen() {
    if (this.#closed) throw new Error("anchored private state is closed");
  }

  #spawn(args) {
    let state;
    try { state = lstatSync(this.#helper.path); }
    catch (error) { throw new Error("anchored private-state helper changed after opening", { cause: error }); }
    if (!sameIdentity(state, this.#helper.identity) || !validHelperState(state)) {
      throw new Error("anchored private-state helper changed after opening");
    }
    return spawn(this.#helper.path, args, {
      stdio: ["pipe", "pipe", "pipe", this.#handle.fd],
    });
  }

  async #run(args, input) {
    await this.assertCurrent();
    const child = this.#spawn(args);
    if (input) child.stdin.end(input);
    else child.stdin.end();
    const result = await childResult(child);
    await this.assertCurrent();
    return result;
  }
}

async function validateHelper(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("helperPath must be an absolute path");
  const configured = resolve(value);
  const configuredState = await lstat(configured);
  if (configuredState.isSymbolicLink()) throw new Error("anchored private-state helper must not be a symlink");
  const path = await realpath(value);
  if (path !== configured) throw new Error("anchored private-state helper must be canonical");
  const state = await lstat(path);
  if (!validHelperState(state)) {
    throw new Error("anchored private-state helper must be a non-writable regular file");
  }
  if (process.getuid && state.uid !== process.getuid() && state.uid !== 0) {
    throw new Error("anchored private-state helper must be owned by the current user or root");
  }
  return { path, identity: { dev: state.dev, ino: state.ino } };
}

function validHelperState(state) {
  return state.isFile() && !state.isSymbolicLink() && (state.mode & 0o222) === 0 && (state.mode & 0o111) !== 0;
}

function validateName(name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name) || name === "." || name === "..") {
    throw new TypeError("private-state name must be a basename without separators or dot entries");
  }
}

function assertPrivate(state, label) {
  if (process.getuid && state.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if ((state.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or other access`);
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

async function childResult(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    const error = new Error(detail || `anchored private-state helper exited with ${code ?? signal}`);
    if (code === 2) error.code = "ENOENT";
    throw error;
  }
  return Buffer.concat(stdout);
}

function trackChild(child) {
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const result = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error, code: null, signal: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { result, stderr: () => Buffer.concat(errors).toString("utf8").trim() };
}

function childExitError(outcome, detail = "") {
  if (outcome.error) return outcome.error;
  const error = new Error(detail || `anchored private-state helper exited with ${outcome.code ?? outcome.signal}`);
  if (outcome.code === 2) error.code = "ENOENT";
  if (detail.includes("writer lock is already held")) error.code = "instance_already_running";
  return error;
}

async function waitForReady(child, tracked) {
  let output = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onExit = (outcome) => {
      cleanup();
      reject(childExitError(outcome, tracked.stderr()));
    };
    const onData = (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.includes("ready\n")) { cleanup(); resolve(true); }
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
    };
    void tracked.result.then(onExit);
    child.stdout.on("data", onData);
  });
}
