import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { noCapabilities } from "../core/types.js";
import { ensurePrivateDirectory, readPrivateFileBounded, writePrivateFileAtomic } from "../secure-state.js";
import { acquireInstanceLock } from "../instance-lock.js";

const STATE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 1_000_000;
const MAX_RECORDS = 1_000;
const DISCOVERY_CONCURRENCY = 8;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const ATTEMPT_ID = /^attempt:[0-9a-f-]{36}$/;
const LAUNCH_ID = /^launch:[0-9a-f-]{36}$/;
const RECORD_KEYS = new Set([
  "attemptId", "launchId", "providerAgentId", "agentId", "target", "profile", "sdkVersion",
  "bridgeNamespace", "storeScope", "targetDigest", "state", "createdAt", "updatedAt",
]);
const STATE_KEYS = new Set(["schemaVersion", "records"]);

export class CursorSdkAdapter {
  id = "cursor-sdk";
  discoveryHealth = "internal";
  #bridge;
  #targets;
  #state;
  #storeDirectory;
  #storeIdentity;
  #scope;
  #sdkVersion;
  #now;
  #activeOperations = new Set();
  #closing;
  #lifecycleGeneration = 0;
  #ready = false;

  constructor(options = {}) {
    this.#bridge = validateBridge(options.bridge);
    this.#sdkVersion = requiredString(options.sdkVersion, "sdkVersion");
    if (this.#bridge.sdkVersion !== this.#sdkVersion) {
      throw new Error(`Cursor SDK bridge version mismatch: expected ${this.#sdkVersion}`);
    }
    this.#storeDirectory = absolutePath(options.storeDirectory, "storeDirectory");
    this.#targets = normalizeTargets(options.targets);
    this.#now = options.now ?? Date.now;
    const provenanceFile = absolutePath(options.provenanceFile, "provenanceFile");
    if (pathsOverlap(this.#storeDirectory, provenanceFile)) {
      throw new Error("Cursor SDK provenance state must be outside the bridge-managed store");
    }
    for (const target of this.#targets.values()) {
      if (pathsOverlap(target.cwd, this.#storeDirectory) || pathWithin(target.cwd, provenanceFile)) {
        throw new Error("Cursor SDK private state must be outside configured workspaces");
      }
    }
    this.#state = new CursorSdkProvenanceStore(provenanceFile, options.fs, this.#now);
    this.#scope = createHash("sha256").update(this.#storeDirectory).digest("base64url").slice(0, 16);
  }

  launchCapabilities() {
    if (!this.#ready) return null;
    return {
      provider: "cursor",
      capabilityVersion: `cursor-sdk-local-${this.#sdkVersion}`,
      targets: [...this.#targets.values()].map((target) => ({
        id: target.id,
        profiles: [...target.profiles],
        modes: [{ id: "local", enabled: true, localMutation: true, externalBillable: true }],
      })),
    };
  }

  async discover() { return []; }

  async open() {
    const generation = this.#lifecycleGeneration;
    await this.#closing;
    await ensurePrivateDirectory(this.#storeDirectory);
    this.#storeIdentity = await directoryIdentity(this.#storeDirectory, "store");
    for (const target of this.#targets.values()) {
      if (pathsOverlap(target.cwd, this.#storeDirectory)) {
        throw new Error("Cursor SDK private state must be outside configured workspaces");
      }
    }
    await this.#state.open();
    if (generation !== this.#lifecycleGeneration) {
      await this.#state.close();
      throw new Error("Cursor SDK adapter opening was interrupted by close");
    }
    this.#ready = true;
  }

  async launch(request, { attemptId, launchId, signal } = {}) {
    return this.#run(async () => {
      const target = this.#target(request);
      await assertDirectoryIdentity(target.cwd, target.identity, "target");
      const providerAgentId = providerId(attemptId);
      const agentId = publicId(this.#scope, providerAgentId);
      const reserved = await this.#state.reserve({
        attemptId, launchId, providerAgentId, agentId, target: target.id, profile: request.profile,
        sdkVersion: this.#sdkVersion, bridgeNamespace: this.#bridge.namespace, storeScope: this.#scope,
        targetDigest: digest(target.cwd), createdAt: timestamp(this.#now),
      });
      if (!reserved.created) throw new Error("Cursor SDK launch attempt already has durable provenance");
      await this.#assertBridgeDirectories(target);
      const result = await this.#bridge.createLocal({
        agentId: providerAgentId,
        attemptId,
        cwd: target.cwd,
        storeDirectory: this.#storeDirectory,
        profile: request.profile,
        signal,
      });
      assertProviderAgent(result, providerAgentId);
      await this.#state.markOwned(attemptId);
      return { status: "owned", providerAgentId, agentId };
    });
  }

  async reconcileLaunch(record, { signal } = {}) {
    return this.#run(async () => {
      const provenance = await this.#state.get(record.attemptId);
      if (!this.#matchesConfiguration(provenance, record)) {
        return { status: "uncertain", code: "cursor_ownership_unproven" };
      }
      const target = this.#targets.get(provenance.target);
      if (!target) return { status: "uncertain", code: "cursor_target_unavailable" };
      await this.#assertBridgeDirectories(target);
      const result = await this.#bridge.getLocal({
        agentId: provenance.providerAgentId,
        cwd: target.cwd,
        storeDirectory: this.#storeDirectory,
        signal,
      });
      if (!result) return { status: "uncertain", code: "cursor_agent_unconfirmed" };
      assertProviderAgent(result, provenance.providerAgentId);
      if (provenance.state !== "owned") await this.#state.markOwned(record.attemptId);
      return { status: "owned", providerAgentId: provenance.providerAgentId, agentId: provenance.agentId };
    });
  }

  async discoverOwned(records, { signal } = {}) {
    return this.#run(async () => {
      const provenanceByAttempt = await this.#state.snapshot();
      return mapConcurrent(records, DISCOVERY_CONCURRENCY, async (record) => {
        const provenance = this.#verifiedProvenance(provenanceByAttempt.get(record.attemptId), record);
        const target = this.#targets.get(provenance.target);
        await this.#assertBridgeDirectories(target);
        const result = await this.#bridge.getLocal({
          agentId: provenance.providerAgentId,
          cwd: target.cwd,
          storeDirectory: this.#storeDirectory,
          signal,
        });
        if (!result) throw new Error("Cursor SDK owned agent is not present in the dedicated store");
        assertProviderAgent(result, provenance.providerAgentId);
        return this.#agent(record, provenance, result);
      });
    });
  }

  markStale(agent) {
    return { ...agent, status: "unknown", capabilities: noCapabilities(), discovery: { ...agent.discovery, confidence: "low" } };
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#lifecycleGeneration += 1;
    this.#ready = false;
    const closing = (async () => {
      await Promise.allSettled([...this.#activeOperations]);
      await this.#state.close();
    })();
    this.#closing = closing;
    try { await closing; }
    finally { if (this.#closing === closing) this.#closing = undefined; }
  }

  #verifiedProvenance(provenance, record) {
    if (!provenance || provenance.state !== "owned" || provenance.launchId !== record.id
      || provenance.agentId !== record.agentId || provenance.providerAgentId !== record.providerAgentId
      || !this.#matchesConfiguration(provenance, record)) {
      throw new Error("Cursor SDK ownership provenance does not match the launch ledger");
    }
    return provenance;
  }

  #target(request) {
    const target = this.#targets.get(request?.target);
    if (!target || request?.mode !== "local" || !target.profiles.includes(request?.profile)) {
      throw new Error("Cursor SDK launch request does not match the injected adapter configuration");
    }
    return target;
  }

  #assertReady() {
    if (!this.#ready) throw new Error("Cursor SDK adapter must be opened before use");
  }

  async #run(operation) {
    this.#assertReady();
    const active = Promise.resolve().then(operation);
    this.#activeOperations.add(active);
    try { return await active; }
    finally { this.#activeOperations.delete(active); }
  }

  async #assertBridgeDirectories(target) {
    await assertDirectoryIdentity(target.cwd, target.identity, "target");
    await assertDirectoryIdentity(this.#storeDirectory, this.#storeIdentity, "store");
  }

  #matchesConfiguration(provenance, record) {
    if (!provenance || provenance.launchId !== record.id || provenance.sdkVersion !== this.#sdkVersion
      || provenance.bridgeNamespace !== this.#bridge.namespace || provenance.storeScope !== this.#scope
      || (record.providerAgentId !== undefined && provenance.providerAgentId !== record.providerAgentId)
      || (record.agentId !== undefined && provenance.agentId !== record.agentId)
      || provenance.providerAgentId !== providerId(record.attemptId)
      || provenance.agentId !== publicId(this.#scope, provenance.providerAgentId)) return false;
    const target = this.#targets.get(provenance.target);
    return Boolean(target && provenance.targetDigest === digest(target.cwd)
      && provenance.target === record.request?.target && provenance.profile === record.request?.profile
      && record.request?.mode === "local" && record.request?.provider === "cursor"
      && record.request?.capabilityVersion === `cursor-sdk-local-${this.#sdkVersion}`
      && record.request?.risk?.localMutation === true && record.request?.risk?.externalBillable === true);
  }

  #agent(record, provenance, result) {
    const now = timestamp(this.#now);
    const status = result ? normalizeStatus(result.status) : "unknown";
    const capabilities = noCapabilities();
    return {
      id: record.agentId,
      provider: "cursor",
      source: this.id,
      name: cleanName(result?.name) ?? `Cursor · ${provenance.target}`,
      status,
      capabilities,
      lastActivityAt: validTimestamp(result?.lastActivityAt) ? result.lastActivityAt : provenance.updatedAt,
      discovery: { kind: "native", confidence: result ? "high" : "low", visibility: "recent", provenance: "launch-ledger+cursor-sdk-store" },
      pendingApprovals: [],
      metadata: { cursorSdk: { ownedLaunch: true, sdkVersion: provenance.sdkVersion } },
      discoveredAt: now,
      updatedAt: now,
    };
  }
}

export class CursorSdkProvenanceStore {
  #file;
  #read;
  #write;
  #acquireLock;
  #now;
  #lease;
  #tail = Promise.resolve();

  constructor(file, fs = {}, now = Date.now) {
    this.#file = file;
    this.#read = fs.readPrivateFileBounded ?? readPrivateFileBounded;
    this.#write = fs.writePrivateFileAtomic ?? writePrivateFileAtomic;
    this.#acquireLock = fs.acquireInstanceLock ?? acquireInstanceLock;
    this.#now = now;
  }

  async open() {
    return this.#exclusive(async () => {
      await this.#open();
      try { await this.#load(); }
      catch (error) {
        await this.#lease?.release().catch(() => {});
        this.#lease = undefined;
        throw error;
      }
    });
  }

  async reserve(input) {
    return this.#exclusive(async () => {
      await this.#open();
      const record = validateRecord({ ...input, state: "intent", updatedAt: input.createdAt });
      const state = await this.#load();
      const existing = state.records.find((entry) => entry.attemptId === record.attemptId);
      if (existing) {
        if (!sameIntent(existing, record)) throw new Error("Cursor SDK attempt provenance conflicts with existing state");
        return { record: structuredClone(existing), created: false };
      }
      if (state.records.length >= MAX_RECORDS) throw new Error("Cursor SDK provenance state is full");
      state.records.push(record);
      await this.#save(state);
      return { record: structuredClone(record), created: true };
    });
  }

  async markOwned(attemptId) {
    return this.#exclusive(async () => {
      await this.#open();
      const state = await this.#load();
      const index = state.records.findIndex((record) => record.attemptId === attemptId);
      if (index < 0) throw new Error("Cursor SDK provenance intent is missing");
      const updatedAt = timestamp(this.#now);
      state.records[index] = validateRecord({
        ...state.records[index],
        state: "owned",
        updatedAt: Date.parse(updatedAt) < Date.parse(state.records[index].updatedAt)
          ? state.records[index].updatedAt
          : updatedAt,
      });
      await this.#save(state);
      return structuredClone(state.records[index]);
    });
  }

  async get(attemptId) {
    return this.#exclusive(async () => {
      await this.#open();
      const record = (await this.#load()).records.find((entry) => entry.attemptId === attemptId);
      return record && structuredClone(record);
    });
  }

  async snapshot() {
    return this.#exclusive(async () => {
      await this.#open();
      const records = (await this.#load()).records;
      return new Map(records.map((record) => [record.attemptId, structuredClone(record)]));
    });
  }

  async close() {
    return this.#exclusive(async () => {
      await this.#lease?.release();
      this.#lease = undefined;
    });
  }

  async #load() {
    try {
      const parsed = JSON.parse(await this.#read(this.#file, MAX_STATE_BYTES));
      if (parsed?.schemaVersion !== STATE_SCHEMA_VERSION || Object.keys(parsed).some((key) => !STATE_KEYS.has(key))
        || !Array.isArray(parsed.records)
        || parsed.records.length > MAX_RECORDS) throw new Error("invalid Cursor SDK provenance state");
      const records = parsed.records.map(validateRecord);
      if (new Set(records.map((record) => record.attemptId)).size !== records.length
        || new Set(records.map((record) => record.agentId)).size !== records.length
        || new Set(records.map((record) => record.providerAgentId)).size !== records.length) {
        throw new Error("invalid Cursor SDK provenance state");
      }
      return { schemaVersion: STATE_SCHEMA_VERSION, records };
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: STATE_SCHEMA_VERSION, records: [] };
      throw error;
    }
  }

  async #save(state) { await this.#write(this.#file, `${JSON.stringify(state)}\n`); }
  async #open() { this.#lease ??= await this.#acquireLock(`${this.#file}.writer.lock`); }
  #exclusive(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
}

function validateBridge(bridge) {
  if (!bridge || !SAFE_ID.test(bridge.namespace ?? "") || typeof bridge.sdkVersion !== "string"
    || !["createLocal", "getLocal"].every((name) => typeof bridge[name] === "function")) {
    throw new TypeError("Cursor SDK adapter requires an explicitly injected bridge");
  }
  return bridge;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20) throw new TypeError("targets must contain 1-20 entries");
  const result = new Map();
  for (const target of targets) {
    if (!SAFE_ID.test(target?.id ?? "") || result.has(target.id)) throw new TypeError("Cursor SDK target IDs must be unique safe identifiers");
    if (!Array.isArray(target.profiles)) {
      throw new TypeError("Cursor SDK target profiles must be an array of safe identifiers");
    }
    const profiles = [...new Set(target.profiles)];
    if (!profiles.length || profiles.length > 20 || profiles.some((profile) => !SAFE_ID.test(profile))) {
      throw new TypeError("Cursor SDK target profiles must be safe identifiers");
    }
    const directory = canonicalDirectory(target.cwd);
    result.set(target.id, { id: target.id, cwd: directory.path, identity: directory.identity, profiles });
  }
  return result;
}

function validateRecord(record) {
  if (!record || Object.keys(record).some((key) => !RECORD_KEYS.has(key))
    || !ATTEMPT_ID.test(record.attemptId ?? "") || !LAUNCH_ID.test(record.launchId ?? "")
    || !SAFE_ID.test(record.providerAgentId ?? "") || !SAFE_ID.test(record.agentId ?? "")
    || !SAFE_ID.test(record.target ?? "") || !SAFE_ID.test(record.profile ?? "")
    || !SAFE_ID.test(record.sdkVersion ?? "") || !SAFE_ID.test(record.bridgeNamespace ?? "")
    || !/^[A-Za-z0-9_-]{16}$/.test(record.storeScope ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(record.targetDigest ?? "")
    || !["intent", "owned"].includes(record.state)
    || !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new Error("invalid Cursor SDK provenance record");
  }
  return { ...record };
}

function normalizeStatus(status) {
  if (["working", "running"].includes(status)) return "working";
  if (["idle", "completed", "done", "success"].includes(status)) return "idle";
  if (["error", "failed"].includes(status)) return "error";
  return "unknown";
}

function assertProviderAgent(result, expected) {
  if (!result || result.agentId !== expected) throw new Error("Cursor SDK bridge returned an unexpected agent identity");
}

function providerId(attemptId) {
  if (!ATTEMPT_ID.test(attemptId ?? "")) throw new TypeError("valid attemptId is required");
  return `agent_${createHash("sha256").update(attemptId).digest("hex").slice(0, 32)}`;
}

function publicId(scope, providerAgentId) { return `cursor-sdk:${scope}:${providerAgentId}`; }
function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return canonicalPotentialPath(value);
}
function canonicalDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("target cwd must be an absolute path");
  const configured = resolve(value);
  const before = lstatSync(configured);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Cursor SDK target must be a canonical real directory");
  }
  const path = realpathSync(configured);
  const after = lstatSync(configured);
  if (!sameStatIdentity(before, after)) {
    throw new Error("Cursor SDK target must be a stable canonical real directory");
  }
  return { path, identity: statIdentity(after) };
}
async function directoryIdentity(path, kind) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`Cursor SDK ${kind} changed after configuration`);
  }
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameStatIdentity(before, after)
    || (kind === "store" && ((process.getuid && after.uid !== process.getuid()) || (after.mode & 0o077) !== 0))) {
    throw new Error(`Cursor SDK ${kind} changed after configuration`);
  }
  return statIdentity(after);
}
async function assertDirectoryIdentity(path, expected, kind) {
  const actual = await directoryIdentity(path, kind);
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Cursor SDK ${kind} changed after configuration`);
  }
}
function statIdentity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameStatIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function canonicalPotentialPath(value) {
  let current = resolve(value);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(current), ...suffix.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}
function requiredString(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(`${name} must be a safe identifier`);
  return value;
}
function timestamp(now) { return new Date(now()).toISOString(); }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function cleanName(value) {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 160);
  return clean || undefined;
}
function digest(value) { return createHash("sha256").update(value).digest("base64url"); }
function sameIntent(left, right) {
  return [
    "attemptId", "launchId", "providerAgentId", "agentId", "target", "profile", "sdkVersion",
    "bridgeNamespace", "storeScope", "targetDigest",
  ]
    .every((key) => left[key] === right[key]);
}
async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  let firstError;
  const worker = async () => {
    while (!firstError && next < values.length) {
      const index = next;
      next += 1;
      try { results[index] = await mapper(values[index], index); }
      catch (error) { firstError ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (firstError) throw firstError;
  return results;
}
function pathWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function pathsOverlap(left, right) { return pathWithin(left, right) || pathWithin(right, left); }
