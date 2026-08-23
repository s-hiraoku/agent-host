import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { noCapabilities } from "../core/types.js";
import { createRedactor } from "../operations/redact.js";

const STATE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 1_000_000;
const MAX_RECORDS = 1_000;
const DISCOVERY_CONCURRENCY = 8;
const MIN_CREDENTIAL_BYTES = 8;
const MAX_CREDENTIAL_BYTES = 16_384;
const MAX_READ_MESSAGES = 120;
const MAX_READ_MESSAGE_CHARS = 8_192;
const MAX_READ_TEXT_CHARS = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ATTEMPT_ID = /^attempt:[0-9a-f-]{36}$/;
const LAUNCH_ID = /^launch:[0-9a-f-]{36}$/;
const RECORD_KEYS = new Set([
  "attemptId", "launchId", "providerAgentId", "agentId", "target", "profile", "sdkVersion",
  "bridgeNamespace", "storeScope", "targetDigest", "runId", "runPending", "state", "createdAt", "updatedAt",
]);
const STATE_KEYS = new Set(["schemaVersion", "records"]);
const CREDENTIAL_SOURCES = new WeakMap();
const INTERNAL_CREDENTIAL_ERRORS = new WeakSet();

export function createCursorSdkCredentialSource(secretOrCallback) {
  if (typeof secretOrCallback !== "string" && !Buffer.isBuffer(secretOrCallback)
    && typeof secretOrCallback !== "function") {
    throw new TypeError("Cursor SDK credential source requires an explicit secret or secret callback");
  }
  let retained;
  try {
    if (typeof secretOrCallback === "string") retained = credentialBytes(secretOrCallback);
    else if (Buffer.isBuffer(secretOrCallback)) retained = credentialBytes(Buffer.from(secretOrCallback));
    else retained = undefined;
  } catch (error) {
    if (isInternalCredentialError(error)) throw publicCredentialError(error);
    throw error;
  }
  const callback = typeof secretOrCallback === "function" ? secretOrCallback : undefined;
  let closed = false;
  let claimed = false;
  const source = {
    claim() {
      if (claimed) throw new TypeError("Cursor SDK credential source is already assigned to an adapter");
      claimed = true;
      return source;
    },
    async use(operation, signal) {
      if (closed) throw new Error("Cursor SDK credential source is closed");
      if (signal?.aborted) throw credentialCancellation();
      let bytes;
      try {
        bytes = callback
          ? credentialBytes(await callback({ signal }))
          : Buffer.from(retained);
      } catch (error) {
        if (signal?.aborted) throw credentialCancellation();
        if (isInternalCredentialError(error)) throw error;
        throw credentialFailure();
      }
      try {
        if (signal?.aborted) throw credentialCancellation();
        return await operation(bytes);
      } finally {
        bytes.fill(0);
      }
    },
    destroy() {
      closed = true;
      retained?.fill(0);
    },
  };
  const wrapper = Object.freeze({});
  CREDENTIAL_SOURCES.set(wrapper, source);
  return wrapper;
}

export class CursorSdkAdapter {
  id = "cursor-sdk";
  discoveryHealth = "internal";
  #bridge;
  #credentialSource;
  #targets;
  #state;
  #storeDirectory;
  #storeIdentity;
  #scope;
  #sdkVersion;
  #now;
  #activeOperations = new Set();
  #agentActions = new Map();
  #closing;
  #destroying;
  #destroyed = false;
  #lifecycleGeneration = 0;
  #ready = false;

  constructor(options = {}) {
    this.#bridge = validateBridge(options.bridge);
    this.#sdkVersion = requiredString(options.sdkVersion, "sdkVersion");
    if (this.#bridge.sdkVersion !== this.#sdkVersion) {
      throw new Error(`Cursor SDK bridge version mismatch: expected ${this.#sdkVersion}`);
    }
    const store = canonicalPrivateDirectory(options.storeDirectory, "storeDirectory");
    this.#storeDirectory = store.path;
    this.#storeIdentity = store.identity;
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
    this.#state = new CursorSdkProvenanceStore(provenanceFile, options.privateState, this.#now);
    this.#scope = createHash("sha256").update(this.#storeDirectory).digest("base64url").slice(0, 16);
    this.#credentialSource = validateCredentialSource(options.credentialSource);
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

  onChange(listener) {
    return this.#bridge.onChange?.(listener) ?? (() => {});
  }

  async open() {
    if (this.#destroyed) throw new Error("Cursor SDK adapter is destroyed");
    const generation = this.#lifecycleGeneration;
    await this.#closing;
    if (this.#destroyed) throw new Error("Cursor SDK adapter is destroyed");
    try {
      await this.#bridge.open?.();
      await assertDirectoryIdentity(this.#storeDirectory, this.#storeIdentity, "store");
      for (const target of this.#targets.values()) {
        if (pathsOverlap(target.cwd, this.#storeDirectory)) {
          throw new Error("Cursor SDK private state must be outside configured workspaces");
        }
      }
      await this.#state.open();
    } catch (error) {
      await this.#bridge.close?.().catch(() => {});
      throw error;
    }
    if (generation !== this.#lifecycleGeneration) {
      await this.#state.close();
      await this.#bridge.close?.();
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
      const result = await this.#callBridge("createLocal", {
        agentId: providerAgentId,
        attemptId,
        cwd: target.cwd,
        storeDirectory: this.#storeDirectory,
        profile: request.profile,
      }, signal);
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
      const result = await this.#callBridge("getLocal", {
        agentId: provenance.providerAgentId,
        cwd: target.cwd,
        storeDirectory: this.#storeDirectory,
      }, signal);
      if (!result) return { status: "uncertain", code: "cursor_agent_unconfirmed" };
      assertProviderAgent(result, provenance.providerAgentId);
      if (provenance.state !== "owned") await this.#state.markOwned(record.attemptId);
      return { status: "owned", providerAgentId: provenance.providerAgentId, agentId: provenance.agentId };
    });
  }

  async discoverOwned(records, { signal } = {}) {
    return this.#run(async () => {
      const provenanceByAttempt = await this.#state.snapshot();
      await assertDirectoryIdentity(this.#storeDirectory, this.#storeIdentity, "store");
      return mapConcurrent(records, DISCOVERY_CONCURRENCY, async (record) => {
        throwIfAborted(signal);
        const provenance = this.#verifiedProvenance(provenanceByAttempt.get(record.attemptId), record);
        const target = this.#targets.get(provenance.target);
        try {
          await assertDirectoryIdentity(target.cwd, target.identity, "target");
          throwIfAborted(signal);
        }
        catch (error) {
          throwIfAborted(signal);
          return this.#agent(record, provenance);
        }
        try {
          await assertDirectoryIdentity(this.#storeDirectory, this.#storeIdentity, "store");
          throwIfAborted(signal);
        } catch (error) {
          throwIfAborted(signal);
          throw error;
        }
        let result;
        try {
          result = await this.#callBridge("getLocal", {
            agentId: provenance.providerAgentId,
            cwd: target.cwd,
            storeDirectory: this.#storeDirectory,
          }, signal);
          throwIfAborted(signal);
        }
        catch (error) {
          throwIfAborted(signal);
          return this.#agent(record, provenance);
        }
        if (!result) return this.#agent(record, provenance);
        assertProviderAgent(result, provenance.providerAgentId);
        return this.#agent(record, provenance, result);
      });
    });
  }

  async prompt(agent, text, { signal } = {}) {
    return this.#run(() => this.#exclusiveAgent(agent?.id, async () => {
      if (typeof text !== "string" || text.trim() === "") {
        throw new TypeError("Cursor SDK prompt must be non-empty");
      }
      const context = await this.#actionContext(agent, "prompt", signal);
      await this.#state.beginRun(context.provenance.attemptId);
      let bridgeInvoked = false;
      let accepted = false;
      try {
        await this.#assertBridgeDirectories(context.target);
        const result = await this.#callBridge("sendLocal", {
          agentId: context.provenance.providerAgentId,
          cwd: context.target.cwd,
          storeDirectory: this.#storeDirectory,
          text,
        }, signal, () => { bridgeInvoked = true; });
        accepted = true;
        assertProviderAgent(result, context.provenance.providerAgentId);
        if (!SAFE_RUN_ID.test(result?.runId ?? "")) {
          throw new Error("Cursor SDK bridge did not return an exact run identity");
        }
        await this.#assertBridgeDirectories(context.target);
        await this.#state.commitRun(context.provenance.attemptId, result.runId);
        return { ok: true, agentId: agent.id, action: "prompt" };
      } catch (error) {
        if (!bridgeInvoked || (!accepted && ["not_sent", "rejected"].includes(error?.sendDisposition))) {
          await this.#state.restoreRun(context.provenance.attemptId).catch(() => {});
        }
        if (accepted) {
          await this.#callBridge("cancelLocal", {
            agentId: context.provenance.providerAgentId,
            cwd: context.target.cwd,
            storeDirectory: this.#storeDirectory,
          }).catch(() => {});
        }
        throw error;
      }
    }));
  }

  async interrupt(agent, { signal } = {}) {
    return this.#run(() => this.#exclusiveAgent(agent?.id, async () => {
      const context = await this.#actionContext(agent, "interrupt", signal);
      const result = await this.#callBridge("cancelLocal", {
        agentId: context.provenance.providerAgentId,
        cwd: context.target.cwd,
        storeDirectory: this.#storeDirectory,
      }, signal);
      assertProviderAgent(result, context.provenance.providerAgentId);
      return { ok: true, agentId: agent.id, action: "interrupt" };
    }));
  }

  async read(agent, { signal } = {}) {
    return this.#run(() => this.#exclusiveAgent(agent?.id, async () => {
      const context = await this.#actionContext(agent, "read", signal);
      const result = await this.#callBridge("readRunLocal", {
        agentId: context.provenance.providerAgentId,
        runId: context.provenance.runId,
        cwd: context.target.cwd,
        storeDirectory: this.#storeDirectory,
      }, signal);
      assertProviderAgent(result, context.provenance.providerAgentId);
      if (result?.runId !== context.provenance.runId) {
        throw new Error("Cursor SDK bridge returned a different run identity");
      }
      await this.#assertBridgeDirectories(context.target);
      return {
        ok: true,
        agentId: agent.id,
        action: "read",
        data: {
          messages: result.messages,
          messageCount: result.messageCount,
          omittedBlockCount: result.omittedBlockCount,
          truncated: result.truncated,
        },
      };
    }));
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
      const results = await Promise.allSettled([this.#state.close(), this.#bridge.close?.()]);
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      throwDisposalErrors(errors);
    })();
    this.#closing = closing;
    try { await closing; }
    finally { if (this.#closing === closing) this.#closing = undefined; }
  }

  destroy() {
    if (this.#destroying) return this.#destroying;
    if (this.#destroyed) return Promise.resolve();
    this.#destroyed = true;
    this.#destroying = (async () => {
      const errors = [];
      this.#lifecycleGeneration += 1;
      this.#ready = false;
      if (this.#closing) {
        try { await this.#closing; }
        catch (error) { errors.push(error); }
      } else {
        await Promise.allSettled([...this.#activeOperations]);
      }
      try { await this.#state.dispose(); }
      catch (error) { errors.push(error); }
      try { this.#credentialSource.destroy(); }
      catch (error) { errors.push(error); }
      try {
        if (typeof this.#bridge.destroy === "function") await this.#bridge.destroy();
        else await this.#bridge.close?.();
      } catch (error) { errors.push(error); }
      throwDisposalErrors(errors);
    })();
    return this.#destroying;
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
    if (!target || request?.provider !== "cursor" || request?.mode !== "local"
      || request?.capabilityVersion !== `cursor-sdk-local-${this.#sdkVersion}`
      || request?.risk?.localMutation !== true || request?.risk?.externalBillable !== true
      || !target.profiles.includes(request?.profile)) {
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

  async #exclusiveAgent(agentId, operation) {
    const previous = this.#agentActions.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#agentActions.set(agentId, current);
    try { return await current; }
    finally { if (this.#agentActions.get(agentId) === current) this.#agentActions.delete(agentId); }
  }

  async #assertBridgeDirectories(target) {
    await this.#state.assertCurrent();
    await assertDirectoryIdentity(target.cwd, target.identity, "target");
    await assertDirectoryIdentity(this.#storeDirectory, this.#storeIdentity, "store");
  }

  async #actionContext(agent, capability, signal) {
    if (!agent || agent.provider !== "cursor" || agent.source !== this.id
      || agent.capabilities?.[capability] !== true
      || agent.metadata?.cursorSdk?.ownedLaunch !== true
      || agent.metadata.cursorSdk.sdkVersion !== this.#sdkVersion) {
      throw new Error("Cursor SDK action requires an owned current agent capability");
    }
    const provenance = [...(await this.#state.snapshot()).values()].find((entry) => (
      entry.state === "owned" && entry.agentId === agent.id
    ));
    const target = provenance && this.#targets.get(provenance.target);
    if (!target || provenance.sdkVersion !== this.#sdkVersion
      || provenance.bridgeNamespace !== this.#bridge.namespace
      || provenance.storeScope !== this.#scope
      || provenance.providerAgentId !== providerId(provenance.attemptId)
      || provenance.agentId !== publicId(this.#scope, provenance.providerAgentId)
      || provenance.targetDigest !== digest(target.cwd)) {
      throw new Error("Cursor SDK action ownership could not be proven");
    }
    await this.#assertBridgeDirectories(target);
    const current = await this.#callBridge("getLocal", {
      agentId: provenance.providerAgentId,
      cwd: target.cwd,
      storeDirectory: this.#storeDirectory,
    }, signal);
    assertProviderAgent(current, provenance.providerAgentId);
    const status = normalizeStatus(current.status);
    const allowed = capability === "prompt"
      ? ["idle", "error"].includes(status) && provenance.runPending !== true
      : capability === "interrupt"
        ? status === "working" && current.interruptible === true
        : ["idle", "error"].includes(status) && provenance.runPending !== true
          && SAFE_RUN_ID.test(provenance.runId ?? "")
          && typeof this.#bridge.readRunLocal === "function";
    if (!allowed) throw new Error("Cursor SDK action requires a current Bridge capability");
    await this.#assertBridgeDirectories(target);
    return { provenance, target };
  }

  async #callBridge(operation, input, signal, onInvoke) {
    try {
      return await this.#credentialSource.use(
        async (credential) => {
          const redact = createRedactor({ secrets: [credential.toString("utf8")] });
          onInvoke?.();
          const result = await this.#bridge[operation]({ ...input, credential, signal });
          if (operation === "readRunLocal") {
            const secret = credential.toString("utf8");
            return sanitizeReadResult(result, secret);
          }
          return redact(result);
        },
        signal,
      );
    } catch (error) {
      if (isInternalCredentialError(error)) throw publicCredentialError(error);
      throwIfAborted(signal);
      const failure = new Error(`Cursor SDK bridge ${operation} failed`);
      failure.code = "cursor_bridge_failed";
      if (operation === "sendLocal" && ["not_sent", "rejected"].includes(error?.sendDisposition)) {
        failure.sendDisposition = error.sendDisposition;
      }
      throw failure;
    }
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
    capabilities.prompt = Boolean(result && status !== "working" && status !== "unknown"
      && provenance.runPending !== true
      && typeof this.#bridge.sendLocal === "function");
    capabilities.interrupt = Boolean(result && status === "working" && result.interruptible === true
      && typeof this.#bridge.cancelLocal === "function");
    capabilities.read = Boolean(result && ["idle", "error"].includes(status) && provenance.runPending !== true
      && SAFE_RUN_ID.test(provenance.runId ?? "") && typeof this.#bridge.readRunLocal === "function");
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
  #directory;
  #lockFile;
  #privateState;
  #now;
  #lease;
  #disposing;
  #disposed = false;
  #tail = Promise.resolve();

  constructor(file, privateState, now = Date.now) {
    const directory = canonicalPrivateDirectory(dirname(file), "provenance directory");
    this.#directory = directory.path;
    this.#file = basename(file);
    this.#lockFile = `${this.#file}.writer.lock`;
    if (!privateState || privateState.directory !== this.#directory
      || !sameIdentity(privateState.identity, directory.identity)
      || !["readFileBounded", "writeFileAtomic", "acquireWriterLock", "assertCurrent", "close"]
        .every((name) => typeof privateState[name] === "function")) {
      throw new TypeError("Cursor SDK provenance requires injected anchored private-state capabilities");
    }
    this.#privateState = privateState;
    this.#now = now;
  }

  async open() {
    return this.#exclusive(async () => {
      await this.#open();
      try { await this.#load(); }
      catch (error) {
        await this.#releaseLease().catch(() => {});
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

  async beginRun(attemptId) {
    return this.#updateOwned(attemptId, (record) => ({ ...record, runPending: true }));
  }

  async commitRun(attemptId, runId) {
    if (!SAFE_RUN_ID.test(runId ?? "")) throw new Error("invalid Cursor SDK run provenance");
    return this.#updateOwned(attemptId, (record) => {
      const updated = { ...record, runId };
      delete updated.runPending;
      return updated;
    });
  }

  async restoreRun(attemptId) {
    return this.#updateOwned(attemptId, (record) => {
      const updated = { ...record };
      delete updated.runPending;
      return updated;
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

  async assertCurrent() {
    return this.#exclusive(async () => {
      await this.#assertOpen();
    });
  }

  async close() {
    return this.#exclusive(async () => {
      await this.#releaseLease();
    });
  }

  async dispose() {
    if (this.#disposing) return this.#disposing;
    this.#disposed = true;
    const disposing = this.#exclusive(async () => {
      const errors = [];
      const lease = this.#lease;
      try { await this.#releaseLease(); }
      catch (error) { errors.push(error); }
      try {
        if (typeof this.#privateState.dispose === "function") await this.#privateState.dispose();
        else await this.#privateState.close();
      } catch (error) { errors.push(error); }
      finally { if (this.#lease === lease) this.#lease = undefined; }
      throwDisposalErrors(errors);
    });
    this.#disposing = disposing;
    return disposing;
  }

  async #load() {
    await this.#assertOpen();
    let contents;
    try {
      contents = await this.#privateState.readFileBounded(this.#file, MAX_STATE_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.#assertOpen();
        return { schemaVersion: STATE_SCHEMA_VERSION, records: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(contents);
    await this.#assertOpen();
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
  }

  async #save(state) {
    await this.#assertOpen();
    await this.#privateState.writeFileAtomic(this.#file, `${JSON.stringify(state)}\n`);
    await this.#assertOpen();
  }
  async #updateOwned(attemptId, update) {
    return this.#exclusive(async () => {
      await this.#open();
      const state = await this.#load();
      const index = state.records.findIndex((record) => record.attemptId === attemptId);
      if (index < 0 || state.records[index].state !== "owned") {
        throw new Error("Cursor SDK owned provenance is missing");
      }
      const updatedAt = timestamp(this.#now);
      state.records[index] = validateRecord({
        ...update(state.records[index]),
        updatedAt: Date.parse(updatedAt) < Date.parse(state.records[index].updatedAt)
          ? state.records[index].updatedAt
          : updatedAt,
      });
      await this.#save(state);
      return structuredClone(state.records[index]);
    });
  }
  async #open() {
    if (this.#disposed) throw new Error("Cursor SDK provenance store is disposed");
    if (this.#lease) {
      await this.#assertOpen();
      return;
    }
    this.#lease = await this.#privateState.acquireWriterLock(this.#lockFile);
    try {
      await this.#privateState.assertCurrent();
    } catch (error) {
      await this.#releaseLease().catch(() => {});
      throw error;
    }
  }
  async #assertOpen() {
    if (!this.#lease) {
      throw new Error("Cursor SDK provenance store is not open");
    }
    await this.#privateState.assertCurrent();
  }
  async #releaseLease() {
    const lease = this.#lease;
    if (!lease) {
      this.#lease = undefined;
      return;
    }
    try { await lease.release(); }
    catch (error) {
      if (lease.isHeld?.() !== true && this.#lease === lease) this.#lease = undefined;
      throw error;
    }
    if (this.#lease === lease) this.#lease = undefined;
  }
  #exclusive(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
}

function throwDisposalErrors(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Cursor SDK terminal disposal failed");
}

function validateBridge(bridge) {
  if (!bridge || !SAFE_ID.test(bridge.namespace ?? "") || typeof bridge.sdkVersion !== "string"
    || !["createLocal", "getLocal"].every((name) => typeof bridge[name] === "function")) {
    throw new TypeError("Cursor SDK adapter requires an explicitly injected bridge");
  }
  return bridge;
}

function validateCredentialSource(source) {
  return claimCursorSdkCredentialSource(source);
}

export function claimCursorSdkCredentialSource(source) {
  const implementation = CREDENTIAL_SOURCES.get(source);
  if (!implementation) {
    throw new TypeError("Cursor SDK requires an explicitly injected credential source");
  }
  return implementation.claim();
}

function credentialBytes(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) throw invalidCredential();
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length < MIN_CREDENTIAL_BYTES || bytes.length > MAX_CREDENTIAL_BYTES) {
    bytes.fill(0);
    throw invalidCredential();
  }
  return bytes;
}

function invalidCredential() {
  return internalCredentialError(
    "cursor_credential_invalid",
    "Cursor SDK credential source returned an invalid credential",
  );
}

function credentialFailure() {
  return internalCredentialError(
    "cursor_credential_unavailable",
    "Cursor SDK credential source is unavailable",
  );
}

function credentialCancellation() {
  return internalCredentialError(
    "cursor_operation_cancelled",
    "Cursor SDK operation was cancelled",
  );
}

function internalCredentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  INTERNAL_CREDENTIAL_ERRORS.add(error);
  return error;
}

function isInternalCredentialError(error) {
  return INTERNAL_CREDENTIAL_ERRORS.has(error);
}

function publicCredentialError(error) {
  const failure = new Error(error.message);
  failure.code = error.code;
  return failure;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20) throw new TypeError("targets must contain 1-20 entries");
  const result = new Map();
  for (const target of targets) {
    if (typeof target?.id !== "string" || !SAFE_ID.test(target.id) || result.has(target.id)) {
      throw new TypeError("Cursor SDK target IDs must be unique safe identifiers");
    }
    if (!Array.isArray(target.profiles)) {
      throw new TypeError("Cursor SDK target profiles must be an array of safe identifiers");
    }
    const profiles = [...new Set(target.profiles)];
    if (!profiles.length || profiles.length > 20
      || profiles.some((profile) => typeof profile !== "string" || !SAFE_ID.test(profile))) {
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
    || (record.runId !== undefined && !SAFE_RUN_ID.test(record.runId))
    || (record.runPending !== undefined && record.runPending !== true)
    || !/^[A-Za-z0-9_-]{16}$/.test(record.storeScope ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(record.targetDigest ?? "")
    || !["intent", "owned"].includes(record.state)
    || (record.state === "intent" && (record.runId !== undefined || record.runPending !== undefined))
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

function sanitizeReadResult(result, secret) {
  if (!result || !Array.isArray(result.messages)
    || !Number.isInteger(result.messageCount) || result.messageCount < 0
    || !Number.isInteger(result.omittedBlockCount) || result.omittedBlockCount < 0
    || typeof result.truncated !== "boolean") {
    throw new Error("invalid Cursor SDK read result");
  }
  const messages = result.messages.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.text !== "string") {
      throw new Error("invalid Cursor SDK read message");
    }
    return { role: message.role, text: message.text.replaceAll(secret, "[REDACTED]") };
  });
  const selected = [];
  let remaining = MAX_READ_TEXT_CHARS;
  let truncated = result.truncated || messages.length > MAX_READ_MESSAGES
    || result.messageCount > messages.length;
  for (let index = messages.length - 1;
    index >= 0 && selected.length < MAX_READ_MESSAGES && remaining > 0;
    index -= 1) {
    const message = messages[index];
    let text = message.text;
    if (text.length > MAX_READ_MESSAGE_CHARS) {
      text = text.slice(0, MAX_READ_MESSAGE_CHARS);
      truncated = true;
    }
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    remaining -= text.length;
    selected.unshift({ role: message.role, text });
  }
  if (selected.length < messages.length) truncated = true;
  return { ...result, messages: selected, truncated };
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
function canonicalPrivateDirectory(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  const configured = resolve(value);
  let before;
  try { before = lstatSync(configured); }
  catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Cursor SDK ${name} must be a pre-created private directory`);
    }
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Cursor SDK ${name} must be a canonical real directory`);
  }
  const path = realpathSync(configured);
  const after = lstatSync(configured);
  if (!sameStatIdentity(before, after)
    || (process.getuid && after.uid !== process.getuid()) || (after.mode & 0o077) !== 0) {
    throw new Error(`Cursor SDK ${name} must be a stable owner-only canonical directory`);
  }
  return { path, identity: statIdentity(after) };
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
    || ((kind === "store" || kind === "provenance" || kind.endsWith(" path"))
      && ((process.getuid && after.uid !== process.getuid()) || (after.mode & 0o077) !== 0))) {
    throw new Error(`Cursor SDK ${kind} changed after configuration`);
  }
  return statIdentity(after);
}
async function assertDirectoryIdentity(path, expected, kind) {
  const actual = await directoryIdentity(path, kind);
  if (!expected || !sameIdentity(actual, expected)) {
    throw new Error(`Cursor SDK ${kind} changed after configuration`);
  }
}
function statIdentity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
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
function throwIfAborted(signal) {
  if (signal?.aborted) throw publicCredentialError(credentialCancellation());
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
