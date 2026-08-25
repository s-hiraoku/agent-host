import { randomUUID } from "node:crypto";
import { readPrivateFileBounded, writePrivateFileAtomic } from "../secure-state.js";
import { LAUNCH_SCHEMA_VERSION, validateLaunchRecord } from "./launch-contracts.js";
import { acquireInstanceLock } from "../instance-lock.js";

const MAX_LEDGER_BYTES = 1_000_000;
const MAX_RECORDS = 1_000;
const MAX_PENDING = 32;
const LEDGER_SCHEMA_VERSION = 2;
const MAX_RETIREMENTS = 100;
const SAFE_HASH = /^[A-Za-z0-9_-]{43}$/;

export class LaunchLedger {
  #path;
  #records = new Map();
  #retirements = new Map();
  #tail = Promise.resolve();
  #opened = false;
  #lease;
  #acquireLock;

  constructor(path, options = {}) {
    if (typeof path !== "string" || !path) throw new TypeError("launch ledger path is required");
    this.#path = path;
    this.#acquireLock = options.acquireLock ?? acquireInstanceLock;
  }

  async open() {
    return this.#exclusive(async () => {
      if (this.#opened) return this.list();
      this.#lease = await this.#acquireLock(`${this.#path}.writer.lock`);
      let parsed;
      try {
        try { parsed = JSON.parse(await readPrivateFileBounded(this.#path, MAX_LEDGER_BYTES)); }
        catch (error) {
          if (error?.code !== "ENOENT") throw new Error("launch ledger is invalid or unavailable", { cause: error });
          parsed = { schemaVersion: LEDGER_SCHEMA_VERSION, records: [], retirements: [] };
          await writePrivateFileAtomic(this.#path, `${JSON.stringify(parsed)}\n`);
        }
        const legacy = parsed?.schemaVersion === LAUNCH_SCHEMA_VERSION && parsed.retirements === undefined;
        if (!parsed || (!legacy && parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) || !Array.isArray(parsed.records)
          || parsed.records.length > MAX_RECORDS || parsed.records.some((record) => !validateLaunchRecord(record))
          || (!legacy && (!Array.isArray(parsed.retirements) || parsed.retirements.length > MAX_RETIREMENTS
            || parsed.retirements.some((entry) => !validRetirement(entry))))) {
          throw new Error("launch ledger has an unsupported or malformed schema");
        }
        const records = new Map();
        const keys = new Set();
        for (const record of parsed.records) {
          if (records.has(record.id) || keys.has(record.keyHash)) throw new Error("launch ledger contains duplicate records");
          records.set(record.id, structuredClone(record));
          keys.add(record.keyHash);
        }
        this.#records = records;
        const retirements = parsed.retirements ?? [];
        if (new Set(retirements.map((entry) => entry.launchId)).size !== retirements.length
          || retirements.some((entry) => records.has(entry.launchId))) {
          throw new Error("launch ledger contains duplicate retirement records");
        }
        this.#retirements = new Map(retirements.map((entry) => [entry.launchId, structuredClone(entry)]));
        this.#opened = true;
        if (legacy) await this.#persist();
        return this.list();
      } catch (error) {
        this.#opened = false;
        this.#records.clear();
        this.#retirements.clear();
        await this.#lease.release().catch(() => {});
        this.#lease = undefined;
        throw error;
      }
    });
  }

  async close() {
    return this.#exclusive(async () => {
      if (!this.#opened) return;
      this.#opened = false;
      this.#records.clear();
      this.#retirements.clear();
      await this.#lease?.release();
      this.#lease = undefined;
    });
  }

  list() {
    this.#assertOpen();
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  get(id) {
    this.#assertOpen();
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  findByKeyHash(keyHash) {
    this.#assertOpen();
    const record = [...this.#records.values()].find((entry) => entry.keyHash === keyHash);
    return record ? structuredClone(record) : undefined;
  }

  retirement(id) {
    this.#assertOpen();
    const entry = this.#retirements.get(id);
    return entry ? structuredClone(entry) : undefined;
  }

  retirements() {
    this.#assertOpen();
    return [...this.#retirements.values()].map((entry) => structuredClone(entry));
  }

  async beginRetirement(id, keyHash, now = new Date().toISOString()) {
    if (!SAFE_HASH.test(keyHash ?? "")) throw new TypeError("invalid retirement idempotency hash");
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current) return undefined;
      if (current.state === "retiring") return structuredClone(current);
      if (current.state !== "owned") throw new Error("only owned launches can be retired");
      const next = {
        ...current,
        state: "retiring",
        retirementKeyHash: keyHash,
        updatedAt: laterTimestamp(current.updatedAt, now),
      };
      if (!validateLaunchRecord(next)) throw new Error("invalid launch retirement transition");
      this.#records.set(id, next);
      try { await this.#persist(); }
      catch (error) { this.#records.set(id, current); throw error; }
      return structuredClone(next);
    });
  }

  async completeRetirement(id, now = new Date().toISOString()) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current || current.state !== "retiring") throw new Error("launch retirement is not fenced");
      const entry = {
        launchId: current.id,
        attemptId: current.attemptId,
        provider: current.request.provider,
        keyHash: current.retirementKeyHash,
        retiredAt: now,
      };
      if (!validRetirement(entry)) throw new Error("invalid launch retirement tombstone");
      const previousRetirements = new Map(this.#retirements);
      this.#records.delete(id);
      this.#retirements.set(id, entry);
      while (this.#retirements.size > MAX_RETIREMENTS) {
        this.#retirements.delete(this.#retirements.keys().next().value);
      }
      try { await this.#persist(); }
      catch (error) {
        this.#records.set(id, current);
        this.#retirements = previousRetirements;
        throw error;
      }
      return structuredClone(entry);
    });
  }

  async cancelRetirement(id, keyHash, now = new Date().toISOString()) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current || current.state !== "retiring" || current.retirementKeyHash !== keyHash) {
        throw new Error("launch retirement fence does not match");
      }
      const next = { ...current, state: "owned", updatedAt: laterTimestamp(current.updatedAt, now) };
      delete next.retirementKeyHash;
      if (!validateLaunchRecord(next)) throw new Error("invalid launch retirement rollback");
      this.#records.set(id, next);
      try { await this.#persist(); }
      catch (error) { this.#records.set(id, current); throw error; }
      return structuredClone(next);
    });
  }

  async reserve({ keyHash, signature, request, now = new Date().toISOString() }) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const existing = [...this.#records.values()].find((record) => record.keyHash === keyHash);
      if (existing) return { created: false, record: structuredClone(existing) };
      const pending = [...this.#records.values()].filter((record) => (
        ["requested", "creating", "uncertain"].includes(record.state)
      ));
      if (pending.length >= MAX_PENDING) return { full: true };
      if (this.#records.size >= MAX_RECORDS) return { full: true };
      const record = {
        id: `launch:${randomUUID()}`,
        attemptId: `attempt:${randomUUID()}`,
        keyHash,
        signature,
        request: structuredClone(request),
        state: "requested",
        requestedAt: now,
        updatedAt: now,
      };
      if (!validateLaunchRecord(record)) throw new Error("invalid launch request record");
      this.#records.set(record.id, record);
      try { await this.#persist(); }
      catch (error) { this.#records.delete(record.id); throw error; }
      return { created: true, record: structuredClone(record) };
    });
  }

  async transition(id, expectedStates, patch, now = new Date().toISOString()) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current) throw new Error("launch record not found");
      if (!expectedStates.includes(current.state)) return structuredClone(current);
      const next = { ...current, ...structuredClone(patch), updatedAt: now };
      if (!validateLaunchRecord(next)) throw new Error("invalid launch state transition");
      this.#records.set(id, next);
      try { await this.#persist(); }
      catch (error) { this.#records.set(id, current); throw error; }
      return structuredClone(next);
    });
  }

  #assertOpen() { if (!this.#opened) throw new Error("launch ledger is not open"); }

  async #persist() {
    const content = `${JSON.stringify({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      records: [...this.#records.values()],
      retirements: [...this.#retirements.values()],
    })}\n`;
    if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new Error("launch ledger exceeds its size limit");
    await writePrivateFileAtomic(this.#path, content);
  }

  #exclusive(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
}

function validRetirement(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).every((key) => ["launchId", "attemptId", "provider", "keyHash", "retiredAt"].includes(key))
    && /^launch:[0-9a-f-]{36}$/.test(entry.launchId ?? "")
    && /^attempt:[0-9a-f-]{36}$/.test(entry.attemptId ?? "")
    && /^[A-Za-z0-9._:-]{1,100}$/.test(entry.provider ?? "")
    && SAFE_HASH.test(entry.keyHash ?? "") && Number.isFinite(Date.parse(entry.retiredAt));
}

function laterTimestamp(previous, candidate) {
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}
