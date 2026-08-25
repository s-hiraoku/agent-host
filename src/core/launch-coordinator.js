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
    this.#started = true;
    for (const retirement of this.#ledger.retirements?.() ?? []) {
      await this.#registry.finalizeLaunchRetirement?.(retirement).catch(() => {});
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
    if (reserved.full) {
      this.#operations?.metrics.increment("launches_rejected", { code: "queue_full" });
      throw new ContractError("launch_queue_full", "launch queue is full; retry later", 429);
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
    const completed = this.#ledger.retirement?.(id);
    if (completed) {
      if (completed.keyHash !== keyHash) throw retirementConflict();
      return { retirement: retirementView(completed), replayed: true };
    }
    let record = this.#ledger.get(id);
    if (!record) throw new ContractError("launch_not_found", "launch not found", 404);
    if (record.state === "retiring" && record.retirementKeyHash !== keyHash) throw retirementConflict();
    if (record.state !== "owned" && record.state !== "retiring") {
      throw new ContractError("launch_not_retirable", "only an owned launch can be retired", 409);
    }
    if (record.state === "owned") record = await this.#ledger.beginRetirement(id, keyHash);
    if (record.retirementKeyHash !== keyHash) throw retirementConflict();
    const existing = this.#retirements.get(id);
    if (existing) return { retirement: retirementView(await existing), replayed: true };
    const operation = this.#finishRetirement(record).finally(() => this.#retirements.delete(id));
    this.#retirements.set(id, operation);
    return { retirement: retirementView(await operation), replayed: false };
  }

  async stop() {
    if (this.#draining) return;
    this.#draining = true;
    this.#queue = [];
    this.#queued.clear();
    for (const controller of this.#controllers) controller.abort(new Error("agent-host is shutting down"));
    await Promise.allSettled([...this.#retirements.values()]);
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
    const operation = this.#finishRetirement(record).finally(() => this.#retirements.delete(record.id));
    this.#retirements.set(record.id, operation);
    await operation.catch(() => {});
  }

  async #finishRetirement(record) {
    this.#registry.deactivateOwnedLaunch?.(record.id);
    await this.#registry.refresh?.({ force: true });
    const invocation = this.#invoke((options) => this.#registry.retireLaunch?.(
      record.request.provider,
      record,
      options,
    ));
    const result = await invocation.result.catch(() => ({ status: "uncertain" }));
    void invocation.settled;
    if (["blocked", "unsupported"].includes(result?.status)) {
      const restored = await this.#ledger.cancelRetirement(record.id, record.retirementKeyHash);
      this.#registry.activateOwnedLaunch?.(restored);
      await this.#registry.refresh?.({ force: true });
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
    const completed = await this.#ledger.completeRetirement(record.id);
    this.#registry.deactivateOwnedLaunch?.(record.id);
    await this.#registry.refresh?.({ force: true });
    await this.#registry.finalizeLaunchRetirement?.(completed).catch(() => {});
    return completed;
  }

  #enqueue(id, kind, provider) {
    if (this.#draining || this.#queued.has(id) || this.#active.has(id)) return;
    this.#queue.push({ id, kind, provider });
    this.#queued.add(id);
    this.#updateGauge();
  }

  #pump() {
    if (this.#draining) return;
    while (this.#active.size < MAX_ACTIVE_GLOBAL) {
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
    const settled = provider.then(() => undefined, () => undefined).finally(() => {
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
    return { result, settled };
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

  #updateGauge() {
    this.#operations?.metrics.setGauge("launch_queue_depth", this.#queue.length + this.#active.size);
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

function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
}
