import {
  appendFileSync, chmodSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_RECENT_LOG_LIMIT = 200;
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_GENERATIONS = 3;
export const MAX_LOG_RECORD_BYTES = 16 * 1024;
const LEVELS = new Map([["debug", 10], ["info", 20], ["warn", 30], ["error", 40]]);
const FIELDS = ["component", "requestId", "adapter", "actionKind", "outcome", "code", "durationMs", "details"];
const ENUM_FIELDS = {
  component: new Set(["registry", "http", "cli", "service", "adapter", "other"]),
  adapter: new Set(["codex", "herdr", "process", "demo", "other"]),
  actionKind: new Set(["prompt", "send-keys", "approve", "reject", "interrupt", "focus", "read", "other"]),
  outcome: new Set(["success", "failure", "timeout", "error", "other"]),
};
const RETRYABLE_SINK_CODES = new Set(["EACCES", "EDQUOT", "EIO", "ENOSPC", "EPERM", "EROFS"]);
const SINK_RETRY_MS = 30_000;
const defaultFileSystem = { appendFileSync, chmodSync, statSync, renameSync, unlinkSync };

export class StructuredLogger {
  #path;
  #level;
  #redact;
  #recent = [];
  #recentLimit;
  #maxBytes;
  #generations;
  #now;
  #fileSystem;
  #sinkFailure = null;
  #sinkRetryAt = 0;

  constructor(options = {}) {
    this.#path = options.path;
    this.#level = options.level ?? "info";
    this.#redact = options.redact ?? ((value) => value);
    this.#recentLimit = options.recentLimit ?? DEFAULT_RECENT_LOG_LIMIT;
    this.#maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    this.#generations = options.generations ?? DEFAULT_LOG_GENERATIONS;
    this.#now = options.now ?? (() => new Date());
    this.#fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    if (!LEVELS.has(this.#level)) throw new Error(`unknown log level: ${this.#level}`);
    if (this.#path) {
      try { ensureLogPath(this.#path); }
      catch (error) {
        if (!RETRYABLE_SINK_CODES.has(error?.code)) throw error;
        this.#recordSinkFailure("initialize", error);
      }
    }
  }

  log(level, event, fields = {}) {
    if (!LEVELS.has(level)) throw new Error(`unknown log level: ${level}`);
    if ((LEVELS.get(level) ?? 0) < LEVELS.get(this.#level)) return;
    const record = {
      timestamp: this.#now().toISOString(),
      level,
      event: String(event).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80),
    };
    for (const field of FIELDS) {
      if (fields[field] !== undefined) record[field] = normalizeField(field, fields[field]);
    }
    let sanitized = this.#redact(record);
    let line = `${JSON.stringify(sanitized)}\n`;
    if (Buffer.byteLength(line) > MAX_LOG_RECORD_BYTES) {
      sanitized = this.#redact({ ...record, details: { truncated: true } });
      line = `${JSON.stringify(sanitized)}\n`;
    }
    this.#recent.push(sanitized);
    if (this.#recent.length > this.#recentLimit) this.#recent.splice(0, this.#recent.length - this.#recentLimit);
    if (this.#path && Date.now() >= this.#sinkRetryAt) {
      try {
        this.#append(line);
        this.#sinkFailure = null;
      } catch (error) {
        this.#recordSinkFailure(error?.operation ?? "write", error);
      }
    }
    return sanitized;
  }

  recent() { return this.#recent.map((record) => structuredClone(record)); }
  sinkStatus() { return this.#sinkFailure ? { available: false, ...this.#sinkFailure } : { available: true }; }
  close() {}

  #append(line) {
    const bytes = Buffer.byteLength(line);
    let currentBytes = 0;
    try { currentBytes = this.#fileSystem.statSync(this.#path).size; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (currentBytes && currentBytes + bytes > this.#maxBytes) {
      try { rotate(this.#path, this.#generations, this.#fileSystem); }
      catch (error) { throw Object.assign(error, { operation: "rotate" }); }
    }
    try {
      this.#fileSystem.appendFileSync(this.#path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      this.#fileSystem.chmodSync(this.#path, 0o600);
    } catch (error) { throw Object.assign(error, { operation: "write" }); }
  }

  #recordSinkFailure(operation, error) {
    const failure = {
      operation,
      code: String(error?.code ?? "log_sink_error").replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 64),
      at: new Date().toISOString(),
    };
    this.#sinkFailure = failure;
    this.#sinkRetryAt = Date.now() + SINK_RETRY_MS;
    const record = this.#redact({
      timestamp: failure.at,
      level: "error",
      event: "logger.sink_failure",
      component: "other",
      outcome: "failure",
      code: failure.code,
      details: { operation },
    });
    this.#recent.push(record);
    if (this.#recent.length > this.#recentLimit) this.#recent.splice(0, this.#recent.length - this.#recentLimit);
  }
}

function normalizeField(field, value) {
  if (ENUM_FIELDS[field]) return ENUM_FIELDS[field].has(String(value)) ? String(value) : "other";
  if (field === "requestId") return /^[A-Za-z0-9._:-]{1,64}$/.test(String(value)) ? String(value) : "other";
  if (field === "code") return String(value).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64);
  if (field === "durationMs") return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  return value;
}

function ensureLogPath(path) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`log directory must be a real directory: ${directory}`);
  if (process.getuid && directoryStat.uid !== process.getuid()) throw new Error(`log directory must be owned by the current user: ${directory}`);
  if ((directoryStat.mode & 0o077) !== 0) throw new Error(`log directory must not grant group or other access: ${directory}`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`log must be a regular file: ${path}`);
    if (process.getuid && stat.uid !== process.getuid()) throw new Error(`log must be owned by the current user: ${path}`);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function rotate(path, generations, fileSystem) {
  for (let index = generations - 1; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    try { fileSystem.unlinkSync(destination); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { fileSystem.renameSync(source, destination); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}
