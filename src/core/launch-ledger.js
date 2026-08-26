import { randomUUID } from "node:crypto";
import { readPrivateFileBounded, writePrivateFileAtomic } from "../secure-state.js";
import { LAUNCH_SCHEMA_VERSION, validateLaunchRecord } from "./launch-contracts.js";
import { acquireInstanceLock } from "../instance-lock.js";

const MAX_LEDGER_BYTES = 1_000_000;
const MAX_RECORDS = 1_000;
const MAX_PENDING = 32;
const LEDGER_SCHEMA_VERSION = 2;
const MAX_RETIREMENTS = 100;
const MAX_RETIREMENT_CLEANUPS = 1_000;
const SAFE_HASH = /^[A-Za-z0-9_-]{43}$/;

export class LaunchLedger {
  #path;
  #records = new Map();
  #retirements = new Map();
  #retirementCleanups = new Map();
  #compactCleanupEncoding = false;
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
      let serialized;
      try {
        try {
          serialized = await readPrivateFileBounded(this.#path, MAX_LEDGER_BYTES);
          parsed = JSON.parse(serialized);
        }
        catch (error) {
          if (error?.code !== "ENOENT") throw new Error("launch ledger is invalid or unavailable", { cause: error });
          parsed = { schemaVersion: LEDGER_SCHEMA_VERSION, records: [], retirements: [], retirementCleanups: [] };
          await writePrivateFileAtomic(this.#path, `${JSON.stringify(parsed)}\n`);
        }
        const legacy = parsed?.schemaVersion === LAUNCH_SCHEMA_VERSION && parsed.retirements === undefined;
        const compactV2 = parsed?.schemaVersion === LEDGER_SCHEMA_VERSION
          && parsed.retirements === undefined && parsed.retirementCleanups === undefined;
        if (!parsed || (!legacy && !compactV2 && parsed.schemaVersion !== LEDGER_SCHEMA_VERSION)
          || !Array.isArray(parsed.records)
          || parsed.records.length > MAX_RECORDS || parsed.records.some((record) => !validateLaunchRecord(record))
          || (!legacy && !compactV2 && (!Array.isArray(parsed.retirements)
            || parsed.retirements.length > MAX_RETIREMENTS
            || parsed.retirements.some((entry) => !validRetirement(entry))))
          || (parsed.retirementCleanups !== undefined && (!Array.isArray(parsed.retirementCleanups)
            || parsed.retirementCleanups.length > MAX_RETIREMENT_CLEANUPS
            || parsed.retirementCleanups.some((entry) => !validRetirementCleanup(entry))))) {
          throw new Error("launch ledger has an unsupported or malformed schema");
        }
        const records = new Map();
        const keys = new Set();
        const claimKey = (key) => {
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        };
        for (const record of parsed.records) {
          if (records.has(record.id) || !claimKey(record.keyHash)
            || (record.retirementKeyHash !== undefined && !claimKey(record.retirementKeyHash))) {
            throw new Error("launch ledger contains duplicate records or idempotency keys");
          }
          records.set(record.id, structuredClone(record));
        }
        this.#records = records;
        const retirements = parsed.retirements ?? [];
        if (new Set(retirements.map((entry) => entry.launchId)).size !== retirements.length
          || retirements.some((entry) => records.has(entry.launchId))) {
          throw new Error("launch ledger contains duplicate retirement records");
        }
        for (const retirement of retirements) {
          if (!claimKey(retirement.creationKeyHash) || !claimKey(retirement.keyHash)) {
            throw new Error("launch ledger contains duplicate idempotency keys");
          }
        }
        this.#retirements = new Map(retirements.map((entry) => [entry.launchId, structuredClone(entry)]));
        const cleanups = parsed.retirementCleanups
          ?? retirements.filter((entry) => entry.cleanupScope !== undefined).map(retirementCleanup);
        if (new Set(cleanups.map((entry) => entry.launchId)).size !== cleanups.length
          || cleanups.some((entry) => {
            const retirement = this.#retirements.get(entry.launchId);
            return retirement !== undefined && !cleanupMatchesRetirement(entry, retirement);
          })) {
          throw new Error("launch ledger contains duplicate or mismatched retirement cleanups");
        }
        this.#retirementCleanups = new Map(cleanups.map((entry) => [entry.launchId, structuredClone(entry)]));
        this.#compactCleanupEncoding = !legacy && parsed.retirementCleanups === undefined;
        this.#opened = true;
        if (legacy) {
          const migrated = serialized.replace(
            /("schemaVersion"\s*:\s*)1\b/,
            (_match, prefix) => `${prefix}${LEDGER_SCHEMA_VERSION}`,
          );
          if (migrated === serialized) throw new Error("launch ledger legacy schema marker is invalid");
          await writePrivateFileAtomic(this.#path, migrated);
        }
        return this.list();
      } catch (error) {
        this.#opened = false;
        this.#records.clear();
        this.#retirements.clear();
        this.#retirementCleanups.clear();
        this.#compactCleanupEncoding = false;
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
      this.#retirementCleanups.clear();
      this.#compactCleanupEncoding = false;
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

  findRetirementByCreationKeyHash(keyHash) {
    this.#assertOpen();
    const entry = [...this.#retirements.values()].find((item) => item.creationKeyHash === keyHash);
    return entry ? structuredClone(entry) : undefined;
  }

  findByRetirementKeyHash(keyHash) {
    this.#assertOpen();
    const record = [...this.#records.values()].find((entry) => entry.retirementKeyHash === keyHash);
    return record ? structuredClone(record) : undefined;
  }

  findRetirementByKeyHash(keyHash) {
    this.#assertOpen();
    const entry = [...this.#retirements.values()].find((item) => item.keyHash === keyHash);
    return entry ? structuredClone(entry) : undefined;
  }

  retirements() {
    this.#assertOpen();
    return [...this.#retirements.values()].map((entry) => structuredClone(entry));
  }

  retirementCleanups() {
    this.#assertOpen();
    return [...this.#retirementCleanups.values()].map((entry) => structuredClone(entry));
  }

  async beginRetirement(id, keyHash, now = new Date().toISOString()) {
    if (!SAFE_HASH.test(keyHash ?? "")) throw new TypeError("invalid retirement idempotency hash");
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current) return undefined;
      if (current.state === "retiring") return structuredClone(current);
      if (current.state !== "owned") throw new Error("only owned launches can be retired");
      const retiringCount = [...this.#records.values()].filter((entry) => entry.state === "retiring").length;
      if (this.#retirementCleanups.size + retiringCount >= MAX_RETIREMENT_CLEANUPS) {
        const error = new Error("retirement cleanup capacity is full");
        error.code = "retirement_cleanup_full";
        throw error;
      }
      const activeConflict = [...this.#records.values()].some((entry) => (
        entry.id !== id && entry.retirementKeyHash === keyHash
      ));
      const completedConflict = [...this.#retirements.values()].some((entry) => entry.keyHash === keyHash);
      const creationConflict = [...this.#records.values()].some((entry) => entry.keyHash === keyHash)
        || [...this.#retirements.values()].some((entry) => entry.creationKeyHash === keyHash);
      if (activeConflict || completedConflict || creationConflict) {
        const error = new Error("retirement idempotency hash is already claimed");
        error.code = "retirement_key_conflict";
        throw error;
      }
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

  async completeRetirement(id, now = new Date().toISOString(), cleanupScope) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#records.get(id);
      if (!current || current.state !== "retiring") throw new Error("launch retirement is not fenced");
      const entry = retirementEntry(current, now, cleanupScope);
      if (!validRetirement(entry)) throw new Error("invalid launch retirement tombstone");
      const previousRetirements = new Map(this.#retirements);
      const previousCleanups = new Map(this.#retirementCleanups);
      this.#records.delete(id);
      this.#retirements.set(id, entry);
      if (entry.cleanupScope !== undefined) {
        this.#retirementCleanups.set(id, retirementCleanup(entry));
      } else {
        this.#retirementCleanups.delete(id);
      }
      while (this.#retirements.size > MAX_RETIREMENTS) {
        this.#retirements.delete(this.#retirements.keys().next().value);
      }
      try { await this.#persist(); }
      catch (error) {
        this.#records.set(id, current);
        this.#retirements = previousRetirements;
        this.#retirementCleanups = previousCleanups;
        throw error;
      }
      return structuredClone(entry);
    });
  }

  async completeRetirementCleanup(id, keyHash) {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = this.#retirementCleanups.get(id);
      if (!current) return false;
      if (current.keyHash !== keyHash) throw new Error("retirement cleanup fence does not match");
      const retirement = this.#retirements.get(id);
      this.#retirementCleanups.delete(id);
      if (this.#compactCleanupEncoding && cleanupMatchesRetirement(current, retirement)) {
        const updated = { ...retirement };
        delete updated.cleanupScope;
        this.#retirements.set(id, updated);
      }
      try { await this.#persist(); }
      catch (error) {
        this.#retirementCleanups.set(id, current);
        if (retirement) this.#retirements.set(id, retirement);
        throw error;
      }
      return true;
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
      const retired = [...this.#retirements.values()].find((entry) => entry.creationKeyHash === keyHash);
      if (retired) return { created: false, retirement: structuredClone(retired) };
      const mutationConflict = [...this.#records.values()].some((record) => record.retirementKeyHash === keyHash)
        || [...this.#retirements.values()].some((entry) => entry.keyHash === keyHash);
      if (mutationConflict) return { conflict: true };
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
    const content = ledgerContent(
      this.#records, this.#retirements, this.#retirementCleanups,
      this.#compactCleanupEncoding,
    );
    if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new Error("launch ledger exceeds its size limit");
    const projected = projectRetirementCompletions(
      this.#records, this.#retirements, this.#retirementCleanups,
    );
    if (Buffer.byteLength(ledgerContent(
      projected.records, projected.retirements, projected.retirementCleanups,
      this.#compactCleanupEncoding,
    )) > MAX_LEDGER_BYTES) {
      throw new Error("launch ledger cannot reserve retirement completion capacity");
    }
    await writePrivateFileAtomic(this.#path, content);
  }

  #exclusive(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
}

function ledgerContent(records, retirements, retirementCleanups, compactCleanupEncoding = false) {
  const document = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    records: [...records.values()],
  };
  if (retirements.size > 0 || retirementCleanups.size > 0) {
    document.retirements = [...retirements.values()];
    if (!compactCleanupEncoding
      || !cleanupsExactlyMatchScopedRetirements(retirements, retirementCleanups)) {
      document.retirementCleanups = [...retirementCleanups.values()];
    }
  }
  return `${JSON.stringify(document)}\n`;
}

function projectRetirementCompletions(recordsSource, retirementsSource, cleanupsSource) {
  const records = new Map(recordsSource);
  const retirementCleanups = new Map(cleanupsSource);
  const retirementCandidates = [...retirementsSource.values()];
  for (const record of recordsSource.values()) {
    if (record.state !== "retiring") continue;
    const entry = retirementEntry(record, record.updatedAt, "x".repeat(16));
    records.delete(record.id);
    retirementCandidates.push(entry);
    retirementCleanups.set(record.id, retirementCleanup(entry));
  }
  retirementCandidates.sort((left, right) => (
    Buffer.byteLength(JSON.stringify(right)) - Buffer.byteLength(JSON.stringify(left))
      || left.launchId.localeCompare(right.launchId)
  ));
  const retirements = new Map(retirementCandidates
    .slice(0, MAX_RETIREMENTS)
    .map((entry) => [entry.launchId, entry]));
  return { records, retirements, retirementCleanups };
}

function retirementEntry(record, now, cleanupScope) {
  return {
    launchId: record.id,
    attemptId: record.attemptId,
    provider: record.request.provider,
    keyHash: record.retirementKeyHash,
    creationKeyHash: record.keyHash,
    signature: record.signature,
    request: structuredClone(record.request),
    requestedAt: record.requestedAt,
    retiredAt: laterTimestamp(record.updatedAt, now),
    ...(cleanupScope === undefined ? {} : { cleanupScope }),
  };
}

function validRetirement(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).every((key) => [
      "launchId", "attemptId", "provider", "keyHash", "creationKeyHash", "signature", "request",
      "requestedAt", "retiredAt", "cleanupScope",
    ].includes(key))
    && /^launch:[0-9a-f-]{36}$/.test(entry.launchId ?? "")
    && /^attempt:[0-9a-f-]{36}$/.test(entry.attemptId ?? "")
    && /^[A-Za-z0-9._:-]{1,100}$/.test(entry.provider ?? "")
    && SAFE_HASH.test(entry.keyHash ?? "") && SAFE_HASH.test(entry.creationKeyHash ?? "")
    && SAFE_HASH.test(entry.signature ?? "")
    && (entry.cleanupScope === undefined || /^[A-Za-z0-9_-]{16}$/.test(entry.cleanupScope))
    && validRetiredRequest(entry.request)
    && entry.provider === entry.request.provider
    && Number.isFinite(Date.parse(entry.requestedAt))
    && Number.isFinite(Date.parse(entry.retiredAt));
}

function retirementCleanup(entry) {
  return {
    launchId: entry.launchId,
    attemptId: entry.attemptId,
    provider: entry.provider,
    keyHash: entry.keyHash,
    ...(entry.cleanupScope === undefined ? {} : { cleanupScope: entry.cleanupScope }),
  };
}

function cleanupMatchesRetirement(cleanup, retirement) {
  return Boolean(retirement && cleanup.launchId === retirement.launchId
    && cleanup.attemptId === retirement.attemptId && cleanup.provider === retirement.provider
    && cleanup.keyHash === retirement.keyHash && cleanup.cleanupScope === retirement.cleanupScope);
}

function cleanupsExactlyMatchScopedRetirements(retirements, retirementCleanups) {
  const scoped = [...retirements.values()].filter((entry) => entry.cleanupScope !== undefined);
  return scoped.length === retirementCleanups.size
    && scoped.every((entry) => cleanupMatchesRetirement(
      retirementCleanups.get(entry.launchId), entry,
    ));
}

function validRetirementCleanup(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).every((key) => [
      "launchId", "attemptId", "provider", "keyHash", "cleanupScope",
    ].includes(key))
    && /^launch:[0-9a-f-]{36}$/.test(entry.launchId ?? "")
    && /^attempt:[0-9a-f-]{36}$/.test(entry.attemptId ?? "")
    && /^[A-Za-z0-9._:-]{1,100}$/.test(entry.provider ?? "")
    && SAFE_HASH.test(entry.keyHash ?? "")
    && /^[A-Za-z0-9_-]{16}$/.test(entry.cleanupScope ?? "");
}

function validRetiredRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const probe = {
    id: "launch:00000000-0000-4000-8000-000000000000",
    attemptId: "attempt:00000000-0000-4000-8000-000000000000",
    keyHash: "a".repeat(43),
    signature: "b".repeat(43),
    request,
    state: "requested",
    requestedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
  return validateLaunchRecord(probe);
}

function laterTimestamp(previous, candidate) {
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}
