import { ContractError } from "./contracts.js";
import {
  launchKeyHash,
  launchRequestSignature,
  launchView,
  normalizeLaunchCapabilities,
  normalizeLaunchRequest,
  validateIdempotencyKey,
} from "./launch-contracts.js";
import { LaunchLedger } from "./launch-ledger.js";

const MAX_ACTIVE_GLOBAL = 4;
const MAX_ACTIVE_PER_PROVIDER = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

export class LaunchCoordinator {
  #registry;
  #ledger;
  #operations;
  #timeoutMs;
  #capabilities = { version: "1", providers: [] };
  #queue = [];
  #queued = new Set();
  #active = new Map();
  #activeProviders = new Map();
  #controllers = new Set();
  #retirements = new Map();
  #retirementQueue = [];
  #activeRetirements = new Map();
  #retirementPreparations = new Map();
  #latePreparationRollbacks = new Set();
  #cleanupQueue = [];
  #queuedCleanups = new Set();
  #cleanupWorker;
  #cleanupPaused = false;
  #draining = false;
  #started = false;

  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#ledger = options.ledger ?? new LaunchLedger(options.ledgerFile);
    this.#operations = options.operations;
    this.#timeoutMs = options.launchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("launchTimeoutMs must be a positive finite number");
    }
  }

  async start() {
    if (this.#started) return;
    const records = await this.#ledger.open();
    this.#capabilities = normalizeLaunchCapabilities(this.#registry.launchCapabilities?.() ?? []);
    const ownedRecords = records.filter((record) => record.state === "owned");
    if (ownedRecords.length
      && typeof this.#registry.recoverLaunchRetirementPreparations === "function") {
      const recovery = this.#invoke((options) => (
        this.#registry.recoverLaunchRetirementPreparations(ownedRecords, options)
      ));
      if (await recovery.result !== true) {
        throw new Error("owned launch retirement preparations could not be recovered");
      }
    }
    this.#started = true;
    for (const cleanup of this.#ledger.retirementCleanups?.() ?? []) {
      this.#enqueueRetirementCleanup(cleanup);
    }
    for (const record of records) {
      if (record.state === "owned") {
        this.#registry.activateOwnedLaunch?.(record);
      } else if (record.state === "requested") {
        this.#enqueue(record.id, "create", record.request.provider);
      } else if (record.state === "creating") {
        const uncertain = await this.#ledger.transition(record.id, ["creating"], {
          state: "uncertain",
          error: { code: "launch_interrupted", retryable: true },
        });
        this.#enqueue(uncertain.id, "reconcile", uncertain.request.provider);
      } else if (record.state === "uncertain") {
        this.#enqueue(record.id, "reconcile", record.request.provider);
      } else if (record.state === "retiring") {
        void this.#resumeRetirement(record);
      }
    }
    this.#pump();
    this.#pumpRetirementCleanup();
  }

  capabilities() { return structuredClone(this.#capabilities); }

  get(id) {
    this.#assertStarted();
    const record = this.#ledger.get(id);
    return record ? launchView(record) : undefined;
  }

  async submit(payload, key) {
    this.#assertStarted();
    if (this.#draining) throw new ContractError("shutting_down", "agent-host is shutting down", 503);
    const keyHash = launchKeyHash(validateIdempotencyKey(key));
    if (this.#ledger.findByRetirementKeyHash?.(keyHash)
      || this.#ledger.findRetirementByKeyHash?.(keyHash)) {
      throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
    }
    const retired = this.#ledger.findRetirementByCreationKeyHash?.(keyHash);
    if (retired) {
      let replayRequest;
      try { replayRequest = normalizeLaunchRequest(payload, capabilitiesForRetirement(retired)); }
      catch { throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409); }
      const signature = launchRequestSignature(replayRequest);
      if (signature !== retired.signature) {
        throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { launch: retiredLaunchView(retired), replayed: true };
    }
    const existing = this.#ledger.findByKeyHash(keyHash);
    if (existing) {
      let replayRequest;
      try { replayRequest = normalizeLaunchRequest(payload, capabilitiesForRecord(existing)); }
      catch { throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409); }
      if (launchRequestSignature(replayRequest) !== existing.signature) {
        throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { launch: launchView(existing), replayed: true };
    }
    const request = normalizeLaunchRequest(payload, this.#capabilities);
    const signature = launchRequestSignature(request);
    const reserved = await this.#ledger.reserve({ keyHash, signature, request });
    if (reserved.conflict) {
      throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
    }
    if (reserved.full) {
      this.#operations?.metrics.increment("launches_rejected", { code: "queue_full" });
      throw new ContractError("launch_queue_full", "launch queue is full; retry later", 429);
    }
    if (reserved.retirement) {
      if (reserved.retirement.signature !== signature) {
        throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { launch: retiredLaunchView(reserved.retirement), replayed: true };
    }
    if (!reserved.created && reserved.record.signature !== signature) {
      throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
    }
    if (reserved.created) {
      this.#emit(reserved.record, "accepted");
      this.#enqueue(reserved.record.id, "create", request.provider);
      this.#pump();
    }
    return { launch: launchView(reserved.record), replayed: !reserved.created };
  }

  async retire(id, payload, key) {
    this.#assertStarted();
    if (this.#draining) throw new ContractError("shutting_down", "agent-host is shutting down", 503);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || payload.confirmDeleteOwnedAgentAndState !== true) {
      throw new ContractError(
        "invalid_retirement_confirmation",
        "confirmDeleteOwnedAgentAndState must be true",
      );
    }
    const keyHash = launchKeyHash(validateIdempotencyKey(key));
    if (this.#ledger.findByKeyHash?.(keyHash)
      || this.#ledger.findRetirementByCreationKeyHash?.(keyHash)) throw retirementConflict();
    const completed = this.#ledger.retirement?.(id);
    if (completed) {
      if (completed.keyHash !== keyHash) throw retirementConflict();
      return { retirement: retirementView(completed), replayed: true };
    }
    const completedForKey = this.#ledger.findRetirementByKeyHash?.(keyHash);
    if (completedForKey && completedForKey.launchId !== id) throw retirementConflict();
    const activeForKey = this.#ledger.findByRetirementKeyHash?.(keyHash);
    if (activeForKey && activeForKey.id !== id) throw retirementConflict();
    let record = this.#ledger.get(id);
    if (!record) throw new ContractError("launch_not_found", "launch not found", 404);
    if (record.state === "retiring" && record.retirementKeyHash !== keyHash) throw retirementConflict();
    if (record.state !== "owned" && record.state !== "retiring") {
      throw new ContractError("launch_not_retirable", "only an owned launch can be retired", 409);
    }
    const replayed = record.state === "retiring";
    const existing = this.#retirements.get(id);
    if (existing) {
      if (existing.keyHash !== keyHash) throw retirementConflict();
      return { retirement: retirementView(await existing.promise), replayed: true };
    }
    if (this.#latePreparationRollbacks.has(id)) {
      throw new ContractError(
        "launch_retirement_uncertain",
        "owned launch retirement preparation is being reconciled",
        503,
      );
    }
    if (record.state === "retiring"
      && this.#retirementPreparations.has(record.request.provider)) {
      throw new ContractError(
        "launch_retirement_uncertain",
        "owned launch retirement preparation is still pending",
        503,
      );
    }
    const entry = this.#trackRetirement(record, keyHash);
    return { retirement: retirementView(await entry.promise), replayed };
  }

  async stop() {
    if (this.#draining) return;
    this.#draining = true;
    this.#queue = [];
    this.#queued.clear();
    const queuedRetirements = this.#retirementQueue.splice(0);
    for (const entry of queuedRetirements) {
      if (this.#retirements.get(entry.record.id) === entry) {
        this.#retirements.delete(entry.record.id);
      }
      entry.reject(new ContractError("shutting_down", "agent-host is shutting down", 503));
    }
    for (const controller of this.#controllers) controller.abort(new Error("agent-host is shutting down"));
    await Promise.allSettled([...this.#retirements.values()].map((entry) => entry.promise));
    await this.#cleanupWorker;
    const active = [...this.#active.values()];
    await Promise.allSettled(active.map((entry) => entry.stateReady));
    this.#updateGauge();
    if (!active.length) await this.#ledger.close?.();
    else void Promise.allSettled(active.map((entry) => entry.task))
      .then(() => this.#ledger.close?.())
      .catch(() => {});
  }

  async #resumeRetirement(record) {
    if (this.#retirements.has(record.id) || this.#draining) return;
    await this.#trackRetirement(record, record.retirementKeyHash).promise.catch(() => {});
  }

  #trackRetirement(record, keyHash) {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = {
      record, keyHash, provider: record.request.provider,
      promise, resolve, reject, settled: Promise.resolve(),
    };
    this.#retirements.set(record.id, entry);
    this.#retirementQueue.push(entry);
    this.#pumpRetirements();
    this.#updateGauge();
    return entry;
  }

  #pumpRetirements() {
    if (this.#draining) return;
    while (this.#active.size + this.#activeRetirements.size < MAX_ACTIVE_GLOBAL) {
      const index = this.#retirementQueue.findIndex((entry) => (
        (this.#activeProviders.get(entry.provider) ?? 0) < MAX_ACTIVE_PER_PROVIDER
      ));
      if (index < 0) break;
      const [entry] = this.#retirementQueue.splice(index, 1);
      this.#activeRetirements.set(entry.record.id, entry);
      this.#activeProviders.set(
        entry.provider,
        (this.#activeProviders.get(entry.provider) ?? 0) + 1,
      );
      const operation = this.#runRetirement(entry.record, entry.keyHash, entry);
      operation.then(entry.resolve, entry.reject);
      const release = () => {
        if (this.#retirements.get(entry.record.id) === entry) {
          this.#retirements.delete(entry.record.id);
        }
        this.#activeRetirements.delete(entry.record.id);
        const count = (this.#activeProviders.get(entry.provider) ?? 1) - 1;
        if (count) this.#activeProviders.set(entry.provider, count);
        else this.#activeProviders.delete(entry.provider);
        this.#updateGauge();
        this.#pump();
        this.#pumpRetirements();
      };
      void operation.then(
        () => entry.settled,
        () => entry.settled,
      ).then(release, release);
    }
  }

  async #runRetirement(record, keyHash, entry) {
    const recovered = record.state === "retiring";
    if (this.#retirementPreparations.has(record.request.provider)) {
      throw new ContractError(
        "launch_retirement_uncertain",
        "owned launch retirement preparation is still pending",
        503,
      );
    }
    if (record.state === "owned") {
      const invocation = this.#invoke((options) => this.#registry.prepareLaunchRetirement?.(
        record.request.provider, record, { ...options, keyHash },
      ));
      const preparation = { settled: invocation.settled };
      this.#retirementPreparations.set(record.request.provider, preparation);
      void preparation.settled.then(() => {
        if (this.#retirementPreparations.get(record.request.provider) === preparation) {
          this.#retirementPreparations.delete(record.request.provider);
        }
      });
      const result = await invocation.result.catch(() => ({ status: "uncertain" }));
      const providerPrepared = result?.status === "prepared";
      if (result?.status === "blocked") {
        throw new ContractError(
          "launch_retirement_capacity",
          "launch provider cannot reserve retirement capacity",
          503,
        );
      }
      const preparationUncertain = result?.status === "uncertain";
      try { record = await this.#ledger.beginRetirement(record.id, keyHash); }
      catch (error) {
        if (providerPrepared || preparationUncertain) {
          const release = this.#invoke((options) => (
            this.#registry.cancelLaunchRetirementPreparation?.(
              record.request.provider, record, { ...options, keyHash },
            )
          ));
          const released = await release.result.catch(() => false);
          if (released !== true) {
            throw new ContractError(
              "launch_retirement_uncertain",
              "owned launch retirement preparation could not be released",
              503,
            );
          }
        }
        if (error?.code === "retirement_key_conflict") throw retirementConflict();
        if (error?.code === "retirement_cleanup_full") {
          throw new ContractError("launch_retirement_capacity", "launch retirement cleanup is full", 503);
        }
        throw error;
      }
      this.#emit(record, "retiring");
      if (preparationUncertain) {
        const cachedAgent = this.#registry.deactivateOwnedLaunch?.(record.id);
        void this.#reconcileLatePreparation(
          record, keyHash, cachedAgent, invocation.outcome,
        ).catch(() => {});
        throw new ContractError(
          "launch_retirement_uncertain",
          "owned launch retirement could not be prepared",
          503,
        );
      }
    }
    if (record.retirementKeyHash !== keyHash) throw retirementConflict();
    if (this.#draining) {
      throw new ContractError("shutting_down", "agent-host is shutting down", 503);
    }
    return this.#finishRetirement(record, recovered, entry);
  }

  async #reconcileLatePreparation(record, keyHash, cachedAgent, outcome) {
    const settled = await outcome;
    if (this.#draining || settled.status !== "fulfilled" || settled.value?.status !== "blocked") return;
    if (this.#retirements.has(record.id)) return;
    const current = this.#ledger.get(record.id);
    if (current?.state !== "retiring" || current.retirementKeyHash !== keyHash) return;
    this.#latePreparationRollbacks.add(record.id);
    try {
      let restored;
      try { restored = await this.#ledger.cancelRetirement(record.id, keyHash); }
      catch { return; }
      this.#registry.activateOwnedLaunch?.(restored, cachedAgent);
      const refresh = this.#invoke((options) => this.#refreshOwnedLaunches(options.signal));
      await refresh.result.catch(() => {});
      this.#emit(restored, "owned");
    } finally {
      this.#latePreparationRollbacks.delete(record.id);
    }
  }

  async #finishRetirement(record, recovered, entry) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      return await this.#finishRetirementWithSignal(record, controller.signal, recovered, entry);
    } finally {
      this.#controllers.delete(controller);
    }
  }

  async #finishRetirementWithSignal(record, signal, recovered, entry) {
    const cachedAgent = this.#registry.deactivateOwnedLaunch?.(record.id);
    await this.#refreshOwnedLaunches(signal);
    const invocation = this.#invoke((options) => this.#registry.retireLaunch?.(
      record.request.provider,
      record,
      options,
    ));
    entry.settled = invocation.settled;
    const result = await invocation.result.catch(() => ({ status: "uncertain" }));
    void invocation.settled;
    if (result?.status === "unsupported" && recovered) {
      throw new ContractError(
        "launch_retirement_uncertain",
        "owned launch retirement could not be confirmed",
        503,
      );
    }
    if (["blocked", "unsupported"].includes(result?.status)) {
      const restored = await this.#ledger.cancelRetirement(record.id, record.retirementKeyHash);
      this.#registry.activateOwnedLaunch?.(restored, cachedAgent);
      await this.#refreshOwnedLaunches(signal);
      this.#emit(restored, "owned");
      throw new ContractError(
        "launch_not_retirable",
        "owned launch is not currently safe to retire",
        409,
      );
    }
    if (result?.status !== "retired") {
      throw new ContractError(
        "launch_retirement_uncertain",
        "owned launch retirement could not be confirmed",
        503,
      );
    }
    const completed = await this.#ledger.completeRetirement(
      record.id, undefined, result.cleanupScope,
    );
    this.#registry.deactivateOwnedLaunch?.(record.id);
    await this.#refreshOwnedLaunches(signal);
    this.#emitRetired(completed);
    this.#enqueueRetirementCleanup(completed);
    return completed;
  }

  #enqueueRetirementCleanup(retirement) {
    if (!retirement?.cleanupScope || this.#queuedCleanups.has(retirement.launchId)) return;
    this.#cleanupQueue.push(retirement);
    this.#queuedCleanups.add(retirement.launchId);
    this.#pumpRetirementCleanup();
  }

  #pumpRetirementCleanup() {
    if (this.#draining || this.#cleanupPaused || this.#cleanupWorker || !this.#cleanupQueue.length) return;
    this.#cleanupWorker = (async () => {
      while (!this.#draining && this.#cleanupQueue.length) {
        const retirement = this.#cleanupQueue.shift();
        try {
          const invocation = this.#invoke((options) => (
            this.#registry.finalizeLaunchRetirement?.(retirement, options)
          ));
          const finalized = await invocation.result;
          if (finalized === true) {
            await this.#ledger.completeRetirementCleanup?.(retirement.launchId, retirement.keyHash);
          }
        } catch {
          this.#cleanupPaused = true;
        } finally {
          this.#queuedCleanups.delete(retirement.launchId);
        }
        if (this.#cleanupPaused) break;
      }
    })().finally(() => { this.#cleanupWorker = undefined; });
  }

  #enqueue(id, kind, provider) {
    if (this.#draining || this.#queued.has(id) || this.#active.has(id)) return;
    this.#queue.push({ id, kind, provider });
    this.#queued.add(id);
    this.#updateGauge();
  }

  #pump() {
    if (this.#draining) return;
    while (this.#active.size + this.#activeRetirements.size < MAX_ACTIVE_GLOBAL) {
      const index = this.#queue.findIndex((item) => (
        this.#activeProviders.get(item.provider) ?? 0
      ) < MAX_ACTIVE_PER_PROVIDER);
      if (index < 0) break;
      const [item] = this.#queue.splice(index, 1);
      this.#queued.delete(item.id);
      this.#activeProviders.set(item.provider, (this.#activeProviders.get(item.provider) ?? 0) + 1);
      let markStateReady;
      const stateReady = new Promise((resolve) => { markStateReady = resolve; });
      const entry = { stateReady };
      this.#active.set(item.id, entry);
      entry.task = this.#run(item, markStateReady).finally(() => {
        this.#active.delete(item.id);
        const count = (this.#activeProviders.get(item.provider) ?? 1) - 1;
        if (count) this.#activeProviders.set(item.provider, count);
        else this.#activeProviders.delete(item.provider);
        this.#updateGauge();
        this.#pumpRetirements();
        this.#pump();
      });
      this.#updateGauge();
    }
  }

  async #run(item, markStateReady) {
    const record = this.#ledger.get(item.id);
    if (!record) { markStateReady(); return; }
    const began = Date.now();
    let outcome = "failure";
    try {
      const state = item.kind === "create" ? await this.#create(record, item) : await this.#reconcile(record, item);
      outcome = state === "owned" ? "success" : state === "uncertain" ? "timeout" : "failure";
    } catch (error) {
      this.#operations?.logger.log("warn", "launch.coordinator", {
        component: "launch", provider: record.request.provider, outcome: "failure", code: "launch_internal_error",
      });
    } finally {
      markStateReady();
      this.#operations?.metrics.observe("launch_latency_ms", Math.max(0, Date.now() - began), {
        provider: record.request.provider, outcome,
      });
      await item.providerSettled;
    }
  }

  async #create(record, item) {
    const creating = await this.#ledger.transition(record.id, ["requested"], { state: "creating", error: undefined });
    if (creating.state !== "creating") return;
    this.#emit(creating, "creating");
    let result;
    const invocation = this.#invoke((options) => this.#registry.launch?.(creating.request.provider, creating, options));
    item.providerSettled = invocation.settled;
    try {
      result = await invocation.result;
    } catch {
      result = { status: "uncertain", code: "launch_delivery_uncertain" };
    }
    return (await this.#settle(creating, normalizeProviderResult(result))).state;
  }

  async #reconcile(record, item) {
    let result;
    const invocation = this.#invoke((options) => this.#registry.reconcileLaunch?.(record.request.provider, record, options));
    item.providerSettled = invocation.settled;
    try {
      result = await invocation.result;
    } catch {
      result = { status: "uncertain", code: "launch_reconciliation_unavailable" };
    }
    if (!result || result.status === "unsupported") return record.state;
    return (await this.#settle(record, normalizeProviderResult(result))).state;
  }

  async #settle(record, result) {
    if (result?.status === "owned") {
      const owned = await this.#ledger.transition(record.id, ["creating", "uncertain"], {
        state: "owned",
        providerAgentId: result.providerAgentId,
        agentId: result.agentId,
        error: undefined,
      });
      if (owned.state === "owned") {
        this.#registry.activateOwnedLaunch?.(owned);
        await this.#registry.refresh?.({ force: true });
        this.#emit(owned, "owned");
      }
      return owned;
    }
    if (result?.status === "failed") {
      const failed = await this.#ledger.transition(record.id, ["creating", "uncertain"], {
        state: "failed",
        error: { code: safeCode(result.code, "launch_failed"), retryable: false },
      });
      this.#emit(failed, "failed");
      return failed;
    }
    const uncertain = await this.#ledger.transition(record.id, ["creating", "uncertain"], {
      state: "uncertain",
      error: { code: safeCode(result?.code, "launch_delivery_uncertain"), retryable: true },
    });
    this.#emit(uncertain, "uncertain");
    return uncertain;
  }

  #invoke(operation) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(controller.signal.reason ?? new Error("launch aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const provider = Promise.resolve().then(() => operation({ signal: controller.signal }));
    const outcome = provider.then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    const settled = outcome.then(() => undefined).finally(() => {
      controller.signal.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("launch deadline reached"));
        reject(new Error("launch deadline reached"));
      }, this.#timeoutMs);
    });
    const result = Promise.race([provider, timeout, aborted]).finally(() => {
      clearTimeout(timer);
    });
    return { result, settled, outcome };
  }

  #emit(record, phase) {
    this.#registry.events?.emit({
      type: "launch.updated",
      launch: launchView(record),
      phase,
      at: new Date().toISOString(),
    });
    this.#operations?.logger.log(phase === "failed" || phase === "uncertain" ? "warn" : "info", "launch.updated", {
      component: "launch", provider: record.request.provider, launchId: record.id, outcome: phase,
    });
  }

  #emitRetired(retirement) {
    this.#registry.events?.emit({
      type: "launch.updated",
      launch: retiredLaunchView(retirement),
      phase: "retired",
      at: new Date().toISOString(),
    });
    this.#operations?.logger.log("info", "launch.updated", {
      component: "launch", provider: retirement.provider, launchId: retirement.launchId, outcome: "retired",
    });
  }

  async #refreshOwnedLaunches(signal) {
    let refresh;
    if (typeof this.#registry.refreshAfterOwnedLaunchChange === "function") {
      refresh = this.#registry.refreshAfterOwnedLaunchChange();
    } else {
      refresh = this.#registry.refresh?.({ force: true });
    }
    await waitForAbort(refresh, signal);
  }

  #updateGauge() {
    this.#operations?.metrics.setGauge(
      "launch_queue_depth",
      this.#queue.length + this.#active.size
        + this.#retirementQueue.length + this.#activeRetirements.size,
    );
  }

  #assertStarted() { if (!this.#started) throw new ContractError("launch_unavailable", "launch service is unavailable", 503); }
}

export class DisabledLaunchCoordinator {
  capabilities() { return { version: "1", providers: [] }; }
  async start() {}
  async stop() {}
  get() { return undefined; }
  async submit() { throw new ContractError("launch_unavailable", "launch service is unavailable", 503); }
  async retire() { throw new ContractError("launch_unavailable", "launch service is unavailable", 503); }
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : fallback;
}

function capabilitiesForRecord(record) {
  return {
    version: "1",
    providers: [{
      provider: record.request.provider,
      capabilityVersion: record.request.capabilityVersion,
      targets: [{
        id: record.request.target,
        profiles: [record.request.profile],
        modes: [{ id: record.request.mode, enabled: true, risk: { ...record.request.risk } }],
      }],
    }],
  };
}

function capabilitiesForRetirement(retirement) {
  return capabilitiesForRecord({ request: retirement.request });
}

function normalizeProviderResult(result) {
  if (result?.status === "owned"
    && isSafeId(result.providerAgentId)
    && isSafeId(result.agentId)) {
    return { status: "owned", providerAgentId: result.providerAgentId, agentId: result.agentId };
  }
  if (result?.status === "failed") return { status: "failed", code: safeCode(result.code, "launch_failed") };
  if (result?.status === "uncertain") {
    return { status: "uncertain", code: safeCode(result.code, "launch_delivery_uncertain") };
  }
  return { status: "uncertain", code: "launch_invalid_result" };
}

function retirementConflict() {
  return new ContractError(
    "idempotency_conflict",
    "Idempotency-Key was already used for this retirement",
    409,
  );
}

function retirementView(entry) {
  return { launchId: entry.launchId, state: "retired", retiredAt: entry.retiredAt };
}

function retiredLaunchView(entry) {
  return {
    id: entry.launchId,
    provider: entry.request.provider,
    target: entry.request.target,
    profile: entry.request.profile,
    mode: entry.request.mode,
    risk: { ...entry.request.risk },
    state: "retired",
    requestedAt: entry.requestedAt,
    updatedAt: entry.retiredAt,
  };
}

function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
}

async function waitForAbort(operation, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("launch retirement aborted");
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(signal.reason ?? new Error("launch retirement aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([Promise.resolve(operation), aborted]); }
  finally { signal?.removeEventListener("abort", onAbort); }
}
