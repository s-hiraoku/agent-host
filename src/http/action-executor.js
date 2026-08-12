import { createHash } from "node:crypto";
import { ContractError } from "../core/contracts.js";

const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const MAX_IDEMPOTENCY_ENTRIES = 1_000;
export const MAX_ACTIONS_PER_AGENT = 32;
export const MAX_ACTIONS_GLOBAL = 256;

export class ActionExecutor {
  #registry;
  #operations;
  #cache = new Map();
  #queues = new Map();
  #active = new Set();
  #queued = 0;
  #draining = false;
  #ttlMs;
  #now;
  #perAgentLimit;
  #globalLimit;
  #actionTimeoutMs;

  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#operations = options.operations;
    this.#ttlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
    this.#now = options.idempotencyNow ?? Date.now;
    this.#perAgentLimit = options.maxActionsPerAgent ?? MAX_ACTIONS_PER_AGENT;
    this.#globalLimit = options.maxActionsGlobal ?? MAX_ACTIONS_GLOBAL;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    if (!Number.isFinite(this.#actionTimeoutMs) || this.#actionTimeoutMs <= 0) {
      throw new RangeError("actionTimeoutMs must be a positive finite number");
    }
  }

  async execute(agentId, action, payload, key) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key ?? "")) {
      throw new ContractError("invalid_idempotency_key", "Idempotency-Key must be 8-128 safe ASCII characters");
    }
    const requestedAt = this.#now();
    for (const [cachedKey, entry] of this.#cache) {
      if (entry.settled && entry.expiresAt <= requestedAt) this.#cache.delete(cachedKey);
    }
    const signature = createHash("sha256").update(JSON.stringify({ agentId, action, payload })).digest("base64url");
    const existing = this.#cache.get(key);
    if (existing) {
      if (existing.signature !== signature) {
        throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { result: await existing.promise, replayed: true };
    }
    if (this.#draining) return this.#reject("shutting_down", "agent-host is shutting down", 503);
    if (this.#cache.size >= MAX_IDEMPOTENCY_ENTRIES) {
      throw new ContractError("idempotency_cache_full", "too many idempotent actions are in progress", 503);
    }
    const queue = this.#queues.get(agentId) ?? [];
    if (queue.length >= this.#perAgentLimit || this.#queued >= this.#globalLimit) {
      return this.#reject("queue_full", "action queue is full; retry later", 429);
    }

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = { signature, promise, settled: false, expiresAt: Infinity };
    const item = { agentId, action, payload, resolve, reject, controller: new AbortController(), started: false };
    queue.push(item);
    this.#queues.set(agentId, queue);
    this.#queued += 1;
    this.#cache.set(key, entry);
    promise.finally(() => {
      entry.settled = true;
      entry.expiresAt = this.#now() + this.#ttlMs;
    }).catch(() => {});
    this.#updateQueueGauge();
    this.#pump(agentId);
    return { result: await promise, replayed: false };
  }

  async shutdown({ graceMs = 5_000 } = {}) {
    this.#draining = true;
    const error = new ContractError("shutting_down", "agent-host is shutting down", 503);
    for (const [agentId, queue] of this.#queues) {
      const pending = queue.filter((item) => !item.started);
      for (const item of pending) {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        this.#queued -= 1;
        item.reject(error);
      }
      if (!queue.length) this.#queues.delete(agentId);
    }
    this.#updateQueueGauge();
    if (!this.#active.size) return { timedOut: false };
    const settled = Promise.allSettled([...this.#active].map((item) => item.promise));
    let timer;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), graceMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) for (const item of this.#active) item.controller.abort(new Error("shutdown deadline reached"));
    return { timedOut };
  }

  get queueDepth() { return this.#queued; }
  get activeCount() { return this.#active.size; }

  #reject(code, message, status) {
    this.#operations?.metrics.increment("actions_rejected", { code });
    throw new ContractError(code, message, status);
  }

  #pump(agentId) {
    const queue = this.#queues.get(agentId);
    const item = queue?.[0];
    if (!item || item.started) return;
    item.started = true;
    item.promise = Promise.resolve().then(async () => {
      const startedAt = this.#now();
      let timer;
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new ContractError("action_timeout", "agent action timed out", 504);
            item.controller.abort(error);
            reject(error);
          }, this.#actionTimeoutMs);
        });
        const result = await Promise.race([
          this.#registry.action(item.agentId, item.action, item.payload, { signal: item.controller.signal }),
          deadline,
        ]);
        this.#operations?.metrics.observe("action_latency_ms", Math.max(0, this.#now() - startedAt), {
          actionKind: item.action,
          outcome: result.ok ? "success" : "failure",
        });
        item.resolve(result);
      } catch (error) {
        this.#operations?.metrics.observe("action_latency_ms", Math.max(0, this.#now() - startedAt), {
          actionKind: item.action,
          outcome: "failure",
        });
        item.reject(error);
      } finally {
        clearTimeout(timer);
      }
    }).finally(() => {
      this.#active.delete(item);
      const current = this.#queues.get(agentId);
      if (current?.[0] === item) current.shift();
      this.#queued -= 1;
      if (!current?.length) this.#queues.delete(agentId);
      this.#updateQueueGauge();
      this.#pump(agentId);
    });
    this.#active.add(item);
  }

  #updateQueueGauge() {
    this.#operations?.metrics.setGauge("action_queue_depth", this.#queued);
  }
}
