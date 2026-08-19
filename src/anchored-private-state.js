import { constants, lstatSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAGIC = 0x41485053;
const VERSION = 1;
const HEADER_BYTES = 32;
const RESPONSE_FLAG = 0x8000;
const OP = Object.freeze({ acquire: 1, read: 2, write: 3, assert: 4, close: 5 });

export async function openAnchoredPrivateState(directory, options = {}) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(`anchored private state is unsupported on ${process.platform}`);
  }
  if (typeof process.geteuid !== "function" || process.geteuid() === 0) {
    throw new Error("anchored private state rejects root execution for the same-UID threat model");
  }
  const helper = await validateTrustedHelper(options.helperPath);
  const state = await validateProtectedDirectory(directory);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new RangeError(`maxBytes must be an integer from 1 to ${DEFAULT_MAX_BYTES}`);
  }
  return new AnchoredPrivateState(state.path, state.identity, helper, maxBytes);
}

class AnchoredPrivateState {
  #helper;
  #maxBytes;
  #session;
  #poison;
  #disposed = false;

  constructor(directory, identity, helper, maxBytes) {
    this.directory = directory;
    this.identity = Object.freeze(identity);
    this.#helper = helper;
    this.#maxBytes = maxBytes;
  }

  async acquireWriterLock(name) {
    this.#assertUsable();
    validateName(name);
    if (this.#session) throw Object.assign(new Error("anchored writer lock is already held"), { code: "instance_already_running" });
    const session = new NativeSession(this.directory, this.#helper, this.#maxBytes, (error) => {
      this.#poison ??= error;
    });
    try {
      await session.acquire(name);
    } catch (error) {
      await session.abandon();
      throw error;
    }
    this.#session = session;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        try {
          await session.close();
          released = true;
          if (this.#session === session) this.#session = undefined;
        } catch (error) {
          if (!session.held && this.#session === session) this.#session = undefined;
          throw error;
        }
      },
      isHeld: () => !released && session.held,
    };
  }

  async readFileBounded(name, maximumBytes) {
    validateName(name);
    const limit = this.#limit(maximumBytes);
    return (await this.#active().request(OP.read, { name, limit })).toString("utf8");
  }

  async writeFileAtomic(name, contents) {
    validateName(name);
    if (typeof contents !== "string" && !Buffer.isBuffer(contents)) {
      throw new TypeError("private state must be a string or Buffer");
    }
    const payload = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    if (payload.length > this.#maxBytes) throw new Error("private state exceeds its size limit");
    const auxiliary = `.agent-host-${randomUUID()}.tmp`;
    await this.#active().request(OP.write, { name, auxiliary, payload, limit: payload.length });
  }

  async assertCurrent() { await this.#active().request(OP.assert); }

  async close() {
    if (!this.#session) return;
    const session = this.#session;
    try {
      await session.close();
      if (this.#session === session) this.#session = undefined;
    } catch (error) {
      if (!session.held && this.#session === session) this.#session = undefined;
      throw error;
    }
  }

  async dispose() {
    if (this.#disposed) return;
    try { await this.close(); }
    catch (error) {
      const session = this.#session;
      if (session) {
        await session.abandon();
        if (this.#session === session) this.#session = undefined;
      }
      throw error;
    } finally { this.#disposed = true; }
  }

  #active() {
    this.#assertUsable();
    if (!this.#session?.held) throw new Error("anchored private state requires an active writer session");
    return this.#session;
  }

  #assertUsable() {
    if (this.#disposed) throw new Error("anchored private state is disposed");
    if (this.#poison) throw new Error("anchored private-state session is poisoned", { cause: this.#poison });
  }

  #limit(value) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError("maximumBytes must be a positive integer");
    return Math.min(value, this.#maxBytes);
  }
}

class NativeSession {
  #child;
  #helper;
  #maxBytes;
  #onUnexpected;
  #buffer = Buffer.alloc(0);
  #pending;
  #tail = Promise.resolve();
  #nextRequest = 1;
  #failure;
  #armed = false;
  #closeAcknowledged = false;
  #exit;
  held = false;

  constructor(directory, helper, maxBytes, onUnexpected) {
    this.#helper = helper;
    this.#maxBytes = maxBytes;
    this.#onUnexpected = onUnexpected;
    this.#child = this.#spawn(directory);
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.resume();
    this.#exit = new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => { if (!settled) { settled = true; resolve(outcome); this.#terminated(outcome); } };
      this.#child.once("error", (error) => finish({ error }));
      this.#child.once("close", (code, signal) => finish({ code, signal }));
    });
  }

  async acquire(name) {
    await this.request(OP.acquire, { name });
    this.held = true;
    this.#armed = true;
    if (this.#failure) {
      this.held = false;
      this.#onUnexpected(this.#failure);
      throw this.#failure;
    }
  }

  request(operation, input = {}) {
    const next = this.#tail.then(() => this.#request(operation, input));
    this.#tail = next.catch(() => {});
    return next;
  }

  async close() {
    if (!this.held) {
      if (this.#failure) throw this.#failure;
      return;
    }
    await this.request(OP.close);
    this.held = false;
    this.#child.stdin.end();
    await this.#boundedExit(true);
  }

  async abandon() {
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    await this.#boundedExit(false).catch(() => {});
  }

  async #request(operation, { name = "", auxiliary = "", payload = Buffer.alloc(0), limit = 0 } = {}) {
    if (this.#failure) throw this.#failure;
    if (this.#pending) throw new Error("anchored private-state protocol is already busy");
    const request = this.#nextRequest++;
    if (this.#nextRequest > 0xffff_ffff) this.#nextRequest = 1;
    const nameBytes = Buffer.from(name, "ascii");
    const auxiliaryBytes = Buffer.from(auxiliary, "ascii");
    if (nameBytes.length > 200 || auxiliaryBytes.length > 200 || payload.length > this.#maxBytes) {
      throw new Error("anchored private-state protocol payload exceeds its bound");
    }
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(MAGIC, 0);
    header.writeUInt16BE(VERSION, 4);
    header.writeUInt16BE(operation, 6);
    header.writeUInt32BE(request, 8);
    header.writeUInt32BE(nameBytes.length, 12);
    header.writeUInt32BE(auxiliaryBytes.length, 16);
    header.writeUInt32BE(payload.length, 20);
    header.writeUInt32BE(limit, 24);
    const response = new Promise((resolve, reject) => { this.#pending = { operation, request, resolve, reject }; });
    const frame = Buffer.concat([header, nameBytes, auxiliaryBytes, payload]);
    try { await writeTo(this.#child.stdin, frame); }
    catch (error) { this.#fail(error); }
    return response;
  }

  #consume(chunk) {
    if (this.#failure) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length < HEADER_BYTES) return;
    const magic = this.#buffer.readUInt32BE(0);
    const version = this.#buffer.readUInt16BE(4);
    const operation = this.#buffer.readUInt16BE(6);
    const request = this.#buffer.readUInt32BE(8);
    const nameLength = this.#buffer.readUInt32BE(12);
    const auxiliaryLength = this.#buffer.readUInt32BE(16);
    const payloadLength = this.#buffer.readUInt32BE(20);
    const errorCode = this.#buffer.readUInt32BE(24);
    const reserved = this.#buffer.readUInt32BE(28);
    const pending = this.#pending;
    if (magic !== MAGIC || version !== VERSION || !pending || operation !== (pending.operation | RESPONSE_FLAG)
      || request !== pending.request || nameLength !== 0 || auxiliaryLength !== 0 || reserved !== 0
      || payloadLength > this.#maxBytes) {
      this.#fail(new Error("invalid anchored private-state protocol response"));
      return;
    }
    if (this.#buffer.length < HEADER_BYTES + payloadLength) return;
    const payload = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength);
    this.#buffer = this.#buffer.subarray(HEADER_BYTES + payloadLength);
    this.#pending = undefined;
    if (pending.operation === OP.close && errorCode === 0) this.#closeAcknowledged = true;
    if (errorCode === 0) pending.resolve(Buffer.from(payload));
    else pending.reject(protocolError(errorCode));
    if (this.#buffer.length !== 0) this.#fail(new Error("unsolicited anchored private-state protocol data"));
  }

  #terminated(outcome) {
    this.held = false;
    const error = new Error(`anchored private-state helper exited unexpectedly (${outcome.code ?? outcome.signal ?? "start-failure"})`);
    if (!this.#closeAcknowledged) this.#fail(error);
  }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    this.held = false;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
    if (this.#armed && !this.#closeAcknowledged) this.#onUnexpected(error);
    if (!this.#child.killed) this.#child.kill("SIGTERM");
  }

  async #boundedExit(afterAcknowledgedClose) {
    const first = await Promise.race([this.#exit, delay(1_000).then(() => null)]);
    if (first) {
      if (afterAcknowledgedClose && (first.error || first.code !== 0)) {
        throw new Error("anchored private-state helper failed after close acknowledgement");
      }
      if (!afterAcknowledgedClose && first.code !== 0 && this.#failure) throw this.#failure;
      return;
    }
    this.#child.kill("SIGTERM");
    const second = await Promise.race([this.#exit, delay(250).then(() => null)]);
    if (!second) this.#child.kill("SIGKILL");
    await this.#exit;
    if (!afterAcknowledgedClose) throw this.#failure ?? new Error("anchored private-state helper did not exit");
  }

  #spawn(directory) {
    let current;
    try { current = lstatSync(this.#helper.path); }
    catch (error) { throw new Error("anchored private-state helper changed after validation", { cause: error }); }
    if (!sameIdentity(current, this.#helper.identity) || !trustedHelperState(current)) {
      throw new Error("anchored private-state helper changed after validation");
    }
    return spawn(this.#helper.path, ["serve", directory], { stdio: ["pipe", "pipe", "pipe"] });
  }
}

async function validateProtectedDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError("anchored private-state directory must be an absolute path");
  }
  const configured = resolve(value);
  const canonical = await realpath(configured);
  if (canonical !== configured) throw new Error("anchored private-state directory must be canonical");
  const state = await lstat(canonical);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.geteuid() || (state.mode & 0o777) !== 0o700) {
    throw new Error("anchored private-state directory must be current-user-owned mode 0700");
  }
  await validateTrustedAncestors(dirname(canonical), "state directory");
  return { path: canonical, identity: { dev: state.dev, ino: state.ino } };
}

async function validateTrustedHelper(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("helperPath must be an absolute path");
  const configured = resolve(value);
  const canonical = await realpath(configured);
  if (canonical !== configured) throw new Error("anchored private-state helper must be canonical");
  const state = await lstat(canonical);
  if (!trustedHelperState(state)) {
    throw new Error("anchored private-state helper must be root-owned, executable, and non-writable");
  }
  await validateTrustedAncestors(dirname(canonical), "helper");
  return { path: canonical, identity: { dev: state.dev, ino: state.ino } };
}

async function validateTrustedAncestors(start, label) {
  let current = start;
  for (;;) {
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== 0 || (state.mode & 0o022) !== 0) {
      throw new Error(`${label} ancestor must be root-owned and non-writable: ${current}`);
    }
    let writable = true;
    try { await access(current, constants.W_OK); }
    catch (error) {
      if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;
      writable = false;
    }
    if (writable) throw new Error(`${label} ancestor is writable by the effective user: ${current}`);
    if (current === "/") return;
    current = dirname(current);
  }
}

function trustedHelperState(state) {
  return state.isFile() && !state.isSymbolicLink() && state.uid === 0
    && (state.mode & 0o222) === 0 && (state.mode & 0o111) !== 0;
}

function validateName(name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name) || name === "." || name === "..") {
    throw new TypeError("private-state name must be a basename without separators or dot entries");
  }
  if (name.startsWith(".agent-host-") && name.endsWith(".tmp")) {
    throw new TypeError("private-state name uses the reserved crash-recovery namespace");
  }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function protocolError(code) {
  const error = new Error(code === 2 ? "private state does not exist"
    : code === 4 ? "anchored writer lock is already held"
      : "anchored private-state helper rejected the operation");
  if (code === 2) error.code = "ENOENT";
  if (code === 4) error.code = "instance_already_running";
  return error;
}

function writeTo(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => error ? reject(error) : resolve());
  });
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
