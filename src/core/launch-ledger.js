import { randomUUID } from "node:crypto";
import { readPrivateFileBounded, writePrivateFileAtomic } from "../secure-state.js";
import { LAUNCH_SCHEMA_VERSION, validateLaunchRecord } from "./launch-contracts.js";
import { acquireInstanceLock } from "../instance-lock.js";

const MAX_LEDGER_BYTES = 1_000_000;
const MAX_RECORDS = 1_000;
const MAX_PENDING = 32;

export class LaunchLedger {
  #path;
  #records = new Map();
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
          parsed = { schemaVersion: LAUNCH_SCHEMA_VERSION, records: [] };
          await writePrivateFileAtomic(this.#path, `${JSON.stringify(parsed)}\n`);
        }
        if (!parsed || parsed.schemaVersion !== LAUNCH_SCHEMA_VERSION || !Array.isArray(parsed.records)
          || parsed.records.length > MAX_RECORDS || parsed.records.some((record) => !validateLaunchRecord(record))) {
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
        this.#opened = true;
        return this.list();
      } catch (error) {
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
    const content = `${JSON.stringify({ schemaVersion: LAUNCH_SCHEMA_VERSION, records: [...this.#records.values()] })}\n`;
    if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new Error("launch ledger exceeds its size limit");
    await writePrivateFileAtomic(this.#path, content);
  }

  #exclusive(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
}
