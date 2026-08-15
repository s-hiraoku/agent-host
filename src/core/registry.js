import { AgentEventBus } from "./event-bus.js";
import { isDeepStrictEqual } from "node:util";
import { compareAgents, matchesView, reconcileAgents } from "./discovery.js";
import {
  normalizeRepositoryContext,
  repositoryContextsEqual,
} from "./repository-associations.js";

const ACTION_CAPABILITIES = new Map([
  ["prompt", "prompt"],
  ["send-keys", "sendKeys"],
  ["approve", "approve"],
  ["reject", "reject"],
  ["interrupt", "interrupt"],
  ["focus", "focus"],
  ["read", "read"],
]);
const DEFAULT_ADAPTER_TIMEOUT_MS = 20_000;
const DEFAULT_HISTORY_TTL_MS = 5 * 60_000;

function sanitizeError(error) {
  const message = String(error?.message ?? error ?? "adapter discovery failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return {
    code: typeof error?.code === "string" ? error.code : "discovery_failed",
    message: message || "adapter discovery failed",
  };
}

function semanticHealth(health) {
  return {
    status: health.status,
    agentCount: health.agentCount,
    error: health.error,
    circuit: health.circuit,
  };
}

function semanticAgent(agent) {
  const {
    discoveredAt: _discoveredAt,
    updatedAt: _updatedAt,
    metadata: _metadata,
    repositoryContext: _repositoryContext,
    ...semantic
  } = agent;
  return semantic;
}

export class AgentRegistry {
  #agents = new Map();
  #adapters = new Map();
  #adapterHealth = new Map();
  #adapterFlights = new Map();
  #adapterTimeoutMs;
  #historyTtlMs;
  #historyAgents = new Map();
  #historyRevision = 0;
  #historyOverlayRevision = 0;
  #rawRevision = 0;
  #historyExpiresAt = 0;
  #historyPromise;
  #historyControllers = new Set();
  #listCacheSource;
  #canonicalCache;
  #rawCache;
  #closeController = new AbortController();
  #closedOutcome;
  #refreshPromise;
  #initialLoading = true;
  #closed = false;
  #revision = 0;
  #repositoryRevision = 0;
  #adapterUnsubscribers = [];
  #adapterRefreshQueued = false;
  #operations;
  #now;
  #circuitBaseMs;
  #circuitMaxMs;
  #circuitThreshold;
  #forcedProbeMinMs;
  #circuits = new Map();
  #currentRefreshForced = false;
  #forcedFollowupPromise;
  events = new AgentEventBus();

  constructor(adapters, options = {}) {
    const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    if (!Number.isInteger(adapterTimeoutMs) || adapterTimeoutMs <= 0) {
      throw new RangeError("adapterTimeoutMs must be a positive integer");
    }
    this.#adapterTimeoutMs = adapterTimeoutMs;
    const historyTtlMs = options.historyTtlMs ?? DEFAULT_HISTORY_TTL_MS;
    if (!Number.isInteger(historyTtlMs) || historyTtlMs <= 0) {
      throw new RangeError("historyTtlMs must be a positive integer");
    }
    this.#historyTtlMs = historyTtlMs;
    this.#operations = options.operations;
    this.#now = options.now ?? Date.now;
    this.#circuitBaseMs = options.circuitBaseMs ?? 1_000;
    this.#circuitMaxMs = options.circuitMaxMs ?? 60_000;
    this.#circuitThreshold = options.circuitThreshold ?? 3;
    this.#forcedProbeMinMs = options.forcedProbeMinMs ?? 1_000;
    for (const [name, value] of Object.entries({
      circuitBaseMs: this.#circuitBaseMs,
      circuitMaxMs: this.#circuitMaxMs,
      circuitThreshold: this.#circuitThreshold,
      forcedProbeMinMs: this.#forcedProbeMinMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
    if (this.#circuitMaxMs < this.#circuitBaseMs) {
      throw new RangeError("circuitMaxMs must be greater than or equal to circuitBaseMs");
    }
    this.#closedOutcome = new Promise((resolve) => this.#closeController.signal.addEventListener(
      "abort",
      () => resolve({ status: "closed" }),
      { once: true },
    ));
    for (const adapter of adapters) {
      this.#adapters.set(adapter.id, adapter);
      this.#adapterHealth.set(adapter.id, {
        id: adapter.id,
        status: "loading",
        lastAttemptAt: null,
        lastSuccessAt: null,
        durationMs: null,
        agentCount: 0,
        error: null,
        circuit: { phase: "closed", consecutiveFailures: 0, nextAttemptAt: null },
      });
      this.#circuits.set(adapter.id, {
        phase: "closed", consecutiveFailures: 0, nextAttemptAt: 0, probeInFlight: false, lastForcedProbeAt: -Infinity,
      });
      const unsubscribe = adapter.onChange?.((event) => {
        if (this.#closed) return;
        if (event?.type === "disconnected") {
          this.#operations?.logger.log("warn", "adapter.disconnected", {
            component: "registry", adapter: adapter.id, outcome: "failure", code: event.error?.code,
          });
          const outcome = {
            adapterId: adapter.id,
            attemptedAt: new Date().toISOString(),
            durationMs: 0,
            status: "error",
            markStale: true,
            error: event.error ?? new Error("adapter transport disconnected"),
          };
          if (!this.#adapterFlights.has(adapter.id)) {
            this.#recordCircuitOutcome(adapter.id, outcome, false);
          }
          this.#applyOutcome(outcome);
        }
        if (this.#refreshPromise) this.#adapterRefreshQueued = true;
        else void this.refresh({ force: false });
      });
      if (typeof unsubscribe === "function") this.#adapterUnsubscribers.push(unsubscribe);
    }
  }

  list() {
    return [...this.#reconciled(false)];
  }
  listRaw() { return [...this.#reconciled(true)]; }
  #reconciled(includeDuplicates) {
    if (this.#listCacheSource !== this.#agents) {
      this.#listCacheSource = this.#agents;
      this.#canonicalCache = undefined;
      this.#rawCache = undefined;
    }
    let cached = includeDuplicates ? this.#rawCache : this.#canonicalCache;
    if (!cached) {
      cached = reconcileAgents([...this.#agents.values()], includeDuplicates).sort(compareAgents);
      if (includeDuplicates) this.#rawCache = cached;
      else this.#canonicalCache = cached;
    }
    return cached;
  }
  async listView(view = "recent") {
    if (view !== "historical" && view !== "raw") {
      return { agents: this.list().filter((agent) => matchesView(agent, view)), cursorRevision: this.#revision };
    }
    await this.#loadHistory();
    if (view === "historical") {
      const combined = new Map(this.#historyAgents);
      for (const agent of this.listRaw()) combined.set(agent.id, agent);
      return {
        agents: reconcileAgents([...combined.values()]).filter((agent) => matchesView(agent, view)).sort(compareAgents),
        cursorRevision: `history:${this.#historyRevision}:${this.#historyOverlayRevision}`,
      };
    }
    const combined = new Map(this.#historyAgents);
    for (const agent of this.listRaw()) combined.set(agent.id, agent);
    return {
      agents: reconcileAgents([...combined.values()], true).sort(compareAgents),
      cursorRevision: `raw:${this.#rawRevision}:${this.#historyRevision}`,
    };
  }
  get(id) { return this.#reconciled(true).find((agent) => agent.id === id) ?? this.#historyAgents.get(id); }
  get revision() { return this.#revision; }
  get repositoryRevision() { return this.#repositoryRevision; }
  repositoryContext(id) {
    const agent = this.get(id);
    if (!agent) return null;
    return {
      revision: this.#repositoryRevision,
      context: normalizeRepositoryContext(agent.repositoryContext),
    };
  }
  get initialLoading() { return this.#initialLoading; }
  get refreshing() { return Boolean(this.#refreshPromise); }
  get closed() { return this.#closed; }
  adapterHealth() {
    return [...this.#adapterHealth.values()].map((health) => ({
      ...health,
      error: health.error ? { ...health.error } : null,
      circuit: { ...health.circuit },
    }));
  }
  readiness() {
    const adapters = this.adapterHealth();
    return {
      ready: !this.#initialLoading && !this.#closed,
      initialLoading: this.#initialLoading,
      refreshing: this.refreshing,
      degraded: adapters.some((adapter) => adapter.status === "error" || adapter.status === "timeout"),
      adapters,
    };
  }

  refresh(options = {}) {
    if (this.#closed) return Promise.resolve(this.list());
    const force = options.force ?? true;
    if (this.#refreshPromise) {
      if (force && !this.#currentRefreshForced) {
        if (!this.#forcedFollowupPromise) {
          let followup;
          followup = this.#refreshPromise.then(() => {
            if (this.#closed) return this.list();
            if (this.#forcedFollowupPromise === followup) this.#forcedFollowupPromise = undefined;
            return this.refresh({ force: true });
          }).finally(() => {
            if (this.#forcedFollowupPromise === followup) this.#forcedFollowupPromise = undefined;
          });
          this.#forcedFollowupPromise = followup;
        }
        return this.#forcedFollowupPromise;
      }
      return this.#refreshPromise;
    }
    this.#currentRefreshForced = force;
    const startedAt = this.#now();
    this.#refreshPromise = this.#runRefresh(force).finally(() => {
      this.#operations?.metrics.observe("refresh_duration_ms", Math.max(0, this.#now() - startedAt));
      this.#initialLoading = false;
      this.#refreshPromise = undefined;
      this.#currentRefreshForced = false;
      if (this.#adapterRefreshQueued && !this.#closed) {
        this.#adapterRefreshQueued = false;
        queueMicrotask(() => { void this.refresh({ force: false }); });
      }
    });
    return this.#refreshPromise;
  }

  async #runRefresh(force) {
    await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        const admission = this.#admitAdapter(adapter.id, force);
        if (!admission.allowed) {
          this.#operations?.metrics.increment("circuit_skips", { adapter: adapter.id });
          return;
        }
        const outcome = this.#normalizeOutcome(adapter, await this.#discoverAdapter(adapter));
        if (!this.#closed) {
          this.#recordCircuitOutcome(adapter.id, outcome, admission.probe);
          this.#applyOutcome(outcome);
        }
      }),
    );
    return this.list();
  }

  #applyOutcome(outcome) {
    const adapter = this.#adapters.get(outcome.adapterId);
    const previousCanonical = new Map(this.list().map((agent) => [agent.id, agent]));
    const previousRepositories = new Map(
      [...this.#agents].map(([id, agent]) => [id, normalizeRepositoryContext(agent.repositoryContext)]),
    );
    const previousRaw = this.listRaw().map(semanticAgent);
    const previousOverlay = historyOverlay(previousRaw, this.#historyAgents);
    const next = new Map(this.#agents);
    const previousHealth = this.#adapterHealth.get(outcome.adapterId);
    const health = this.#healthForOutcome(previousHealth, outcome);
    this.#adapterHealth.set(outcome.adapterId, health);
    const healthChanged = !isDeepStrictEqual(semanticHealth(previousHealth), semanticHealth(health));

    if (outcome.status === "success") {
      for (const [id, agent] of next) {
        if (agent.source === outcome.adapterId) next.delete(id);
      }
      for (const agent of outcome.agents) {
        next.set(agent.id, { ...agent, repositoryContext: normalizeRepositoryContext(agent.repositoryContext) });
      }
    } else {
      if (outcome.markStale && adapter?.markStale) {
        for (const [id, agent] of next) {
          if (agent.source === outcome.adapterId) {
            const stale = adapter.markStale(agent);
            next.set(id, { ...stale, repositoryContext: normalizeRepositoryContext(stale.repositoryContext) });
          }
        }
      }
    }

    const at = new Date().toISOString();
    const normalized = new Map();
    for (const [id, agent] of next) {
      const previous = this.#agents.get(id);
      if (!previous) {
        const discovered = { ...agent, discoveredAt: agent.discoveredAt ?? at, updatedAt: agent.updatedAt ?? at };
        normalized.set(id, discovered);
      } else if (!isDeepStrictEqual(semanticAgent(previous), semanticAgent(agent))) {
        const updated = { ...agent, discoveredAt: previous.discoveredAt, updatedAt: at };
        normalized.set(id, updated);
      } else if (!repositoryContextsEqual(previous.repositoryContext, agent.repositoryContext)) {
        normalized.set(id, { ...previous, repositoryContext: agent.repositoryContext });
      } else {
        normalized.set(id, previous);
      }
    }
    this.#agents = normalized;
    const nextRaw = this.listRaw().map(semanticAgent);
    if (!isDeepStrictEqual(previousRaw, nextRaw)) this.#rawRevision += 1;
    if (!isDeepStrictEqual(previousOverlay, historyOverlay(nextRaw, this.#historyAgents))) {
      this.#historyOverlayRevision += 1;
    }
    const nextCanonical = new Map(this.list().map((agent) => [agent.id, agent]));
    const changes = [];
    for (const [id, agent] of nextCanonical) {
      const previous = previousCanonical.get(id);
      if (!previous) changes.push({ type: "agent.discovered", agent, at });
      else if (!isDeepStrictEqual(semanticAgent(previous), semanticAgent(agent))) {
        changes.push({ type: "agent.updated", agent, at });
      }
    }
    for (const id of previousCanonical.keys()) {
      if (!nextCanonical.has(id)) changes.push({ type: "agent.removed", agentId: id, at });
    }
    if (changes.length) this.#revision += 1;
    for (const change of changes) this.events.emit({ ...change, snapshotRevision: this.#revision });
    const repositoryChanges = [];
    for (const [id, agent] of this.#agents) {
      const previous = previousRepositories.get(id);
      const current = normalizeRepositoryContext(agent.repositoryContext);
      if ((!previous && current.state !== "unsupported")
        || (previous && !repositoryContextsEqual(previous, current))) {
        repositoryChanges.push({ id, state: current.state });
      }
    }
    for (const [id, previous] of previousRepositories) {
      if (!this.#agents.has(id) && previous.state !== "unsupported") {
        repositoryChanges.push({ id, removed: true });
      }
    }
    if (repositoryChanges.length) this.#repositoryRevision += 1;
    for (const change of repositoryChanges) {
      this.events.emit({
        type: "agent.repository-associations.changed",
        agentId: change.id,
        ...(change.state ? { state: change.state } : {}),
        ...(change.removed ? { removed: true } : {}),
        repositoryRevision: this.#repositoryRevision,
        snapshotRevision: this.#revision,
        at,
      });
    }
    if (healthChanged) {
      this.events.emit({
        type: "adapter.health",
        adapter: { ...health },
        at: new Date().toISOString(),
        snapshotRevision: this.#revision,
      });
    }
    const level = outcome.status === "success" ? "debug" : "warn";
    const loggedOutcome = outcome.status === "error" ? "failure" : outcome.status;
    this.#operations?.logger.log(level, "adapter.refresh", {
      component: "registry",
      adapter: outcome.adapterId,
      outcome: loggedOutcome,
      code: health.error?.code,
      durationMs: outcome.durationMs,
    });
  }

  #normalizeOutcome(adapter, outcome) {
    if (outcome.status !== "success" || !adapter?.isDiscoveryCurrent
      || adapter.isDiscoveryCurrent(outcome.agents)) return outcome;
    return {
      ...outcome,
      status: "error",
      markStale: true,
      error: new Error("adapter discovery used a stale transport"),
    };
  }

  #admitAdapter(adapterId, force) {
    const circuit = this.#circuits.get(adapterId);
    const now = this.#now();
    if (circuit.probeInFlight) return { allowed: false, probe: false };
    if (force) {
      if (circuit.consecutiveFailures > 0 && now - circuit.lastForcedProbeAt < this.#forcedProbeMinMs) {
        return { allowed: false, probe: false };
      }
      const probe = circuit.phase !== "closed" || circuit.consecutiveFailures > 0;
      if (probe) {
        circuit.phase = "half_open";
        circuit.probeInFlight = true;
        circuit.lastForcedProbeAt = now;
      }
      return { allowed: true, probe };
    }
    if (now < circuit.nextAttemptAt) return { allowed: false, probe: false };
    if (circuit.phase === "open") {
      circuit.phase = "half_open";
      circuit.probeInFlight = true;
      return { allowed: true, probe: true };
    }
    return { allowed: true, probe: false };
  }

  #recordCircuitOutcome(adapterId, outcome, probe) {
    const circuit = this.#circuits.get(adapterId);
    if (outcome.status === "success") {
      if (circuit.consecutiveFailures > 0) {
        this.#operations?.metrics.increment("adapter_reconnects", { adapter: adapterId });
      }
      circuit.phase = "closed";
      circuit.consecutiveFailures = 0;
      circuit.nextAttemptAt = 0;
      circuit.probeInFlight = false;
      if (probe) this.#operations?.metrics.increment("circuit_probes", { adapter: adapterId, outcome: "success" });
      return;
    }
    if (outcome.reusedTimedOutFlight) {
      circuit.phase = circuit.consecutiveFailures >= this.#circuitThreshold ? "open" : "closed";
      circuit.probeInFlight = false;
      circuit.lastForcedProbeAt = -Infinity;
      return;
    }
    circuit.consecutiveFailures += 1;
    const delay = Math.min(this.#circuitMaxMs, this.#circuitBaseMs * (2 ** (circuit.consecutiveFailures - 1)));
    circuit.nextAttemptAt = this.#now() + delay;
    circuit.phase = circuit.consecutiveFailures >= this.#circuitThreshold ? "open" : "closed";
    circuit.probeInFlight = false;
    this.#operations?.metrics.increment("adapter_failures", { adapter: adapterId });
    if (probe) this.#operations?.metrics.increment("circuit_probes", {
      adapter: adapterId,
      outcome: outcome.status === "timeout" ? "timeout" : "failure",
    });
  }

  async #loadHistory() {
    if (this.#historyExpiresAt > Date.now()) return;
    if (this.#historyPromise) return this.#historyPromise;
    const adapters = [...this.#adapters.values()].filter((adapter) => adapter.discoverHistory);
    this.#historyPromise = Promise.all(adapters.map(async (adapter) => {
      const controller = new AbortController();
      this.#historyControllers.add(controller);
      const failed = { adapterId: adapter.id, agents: null };
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new DOMException("History discovery timed out", "TimeoutError"));
          resolve(failed);
        }, this.#adapterTimeoutMs);
      });
      try {
        const result = await Promise.race([
          Promise.resolve()
            .then(() => adapter.discoverHistory({ signal: controller.signal }))
            .then((agents) => ({ adapterId: adapter.id, agents: Array.isArray(agents) ? agents : null }))
            .catch(() => failed),
          timeout,
          this.#closedOutcome.then(() => failed),
        ]);
        return result;
      } finally {
        clearTimeout(timer);
        this.#historyControllers.delete(controller);
      }
    })).then((results) => {
      const next = new Map(this.#historyAgents);
      let loaded = false;
      for (const result of results) {
        if (!result.agents) continue;
        loaded = true;
        for (const [id, agent] of next) {
          if (agent.source === result.adapterId) next.delete(id);
        }
        for (const agent of result.agents) next.set(agent.id, agent);
      }
      const before = [...this.#historyAgents.values()].map(semanticAgent).sort((a, b) => a.id.localeCompare(b.id));
      const after = [...next.values()].map(semanticAgent).sort((a, b) => a.id.localeCompare(b.id));
      if (!isDeepStrictEqual(before, after)) this.#historyRevision += 1;
      const repositoryChanges = [];
      const historicalIds = new Set([...this.#historyAgents.keys(), ...next.keys()]);
      for (const id of historicalIds) {
        if (this.#agents.has(id)) continue;
        const previous = this.#historyAgents.get(id);
        const current = next.get(id);
        const previousContext = normalizeRepositoryContext(previous?.repositoryContext);
        const currentContext = normalizeRepositoryContext(current?.repositoryContext);
        if (!previous && currentContext.state !== "unsupported") {
          repositoryChanges.push({ id, state: currentContext.state });
        } else if (previous && !current && previousContext.state !== "unsupported") {
          repositoryChanges.push({ id, removed: true });
        } else if (previous && current && !repositoryContextsEqual(previousContext, currentContext)) {
          repositoryChanges.push({ id, state: currentContext.state });
        }
      }
      this.#historyAgents = next;
      if (repositoryChanges.length) this.#repositoryRevision += 1;
      const at = new Date().toISOString();
      for (const change of repositoryChanges) {
        this.events.emit({
          type: "agent.repository-associations.changed",
          agentId: change.id,
          ...(change.state ? { state: change.state } : {}),
          ...(change.removed ? { removed: true } : {}),
          repositoryRevision: this.#repositoryRevision,
          snapshotRevision: this.#revision,
          at,
        });
      }
      if (loaded || adapters.length === 0) this.#historyExpiresAt = Date.now() + this.#historyTtlMs;
    }).finally(() => { this.#historyPromise = undefined; });
    return this.#historyPromise;
  }

  async #discoverAdapter(adapter) {
    let flight = this.#adapterFlights.get(adapter.id);
    if (flight?.timedOut) {
      return {
        adapterId: adapter.id,
        attemptedAt: flight.startedAtIso,
        durationMs: Date.now() - flight.startedAt,
        status: "timeout",
        reusedTimedOutFlight: true,
      };
    }
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        startedAt: Date.now(),
        startedAtIso: new Date().toISOString(),
      };
      flight.promise = Promise.resolve()
        .then(() => adapter.discover({ signal: controller.signal }))
        .then(
          (agents) => Array.isArray(agents)
            ? { status: "success", agents }
            : { status: "error", error: new TypeError("adapter discover() must return an array") },
          (error) => ({ status: "error", error }),
        );
      this.#adapterFlights.set(adapter.id, flight);
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), this.#adapterTimeoutMs);
    });
    const outcome = await Promise.race([flight.promise, this.#closedOutcome, timeout]);
    clearTimeout(timer);
    if (outcome.status === "timeout" && !flight.timedOut) {
      flight.timedOut = true;
      flight.controller.abort(new DOMException("Adapter discovery timed out", "TimeoutError"));
      void flight.promise.then(() => {
        if (this.#adapterFlights.get(adapter.id) === flight) this.#adapterFlights.delete(adapter.id);
      });
    } else if (outcome.status !== "timeout") {
      this.#adapterFlights.delete(adapter.id);
    }
    return {
      adapterId: adapter.id,
      attemptedAt: flight.startedAtIso,
      durationMs: Date.now() - flight.startedAt,
      ...outcome,
    };
  }

  #healthForOutcome(previous, outcome) {
    const circuit = this.#circuits.get(outcome.adapterId);
    const circuitView = {
      phase: circuit.phase,
      consecutiveFailures: circuit.consecutiveFailures,
      nextAttemptAt: circuit.nextAttemptAt ? new Date(circuit.nextAttemptAt).toISOString() : null,
    };
    if (outcome.status === "success") {
      return {
        id: outcome.adapterId,
        status: "healthy",
        lastAttemptAt: outcome.attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        durationMs: outcome.durationMs,
        agentCount: outcome.agents.length,
        error: null,
        circuit: circuitView,
      };
    }
    const error = outcome.status === "timeout"
      ? { code: "discovery_timeout", message: `discovery exceeded ${this.#adapterTimeoutMs}ms` }
      : sanitizeError(outcome.error);
    const safeError = this.#operations?.redact?.(error) ?? error;
    return {
      ...previous,
      status: outcome.status,
      lastAttemptAt: outcome.attemptedAt,
      durationMs: outcome.durationMs,
      error: safeError,
      circuit: circuitView,
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#adapterUnsubscribers.splice(0)) unsubscribe();
    this.#closeController.abort();
    for (const flight of this.#adapterFlights.values()) flight.controller.abort();
    for (const controller of this.#historyControllers) controller.abort();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close?.()));
    await Promise.allSettled([this.#refreshPromise, this.#historyPromise].filter(Boolean));
    this.#adapterFlights.clear();
    this.#historyControllers.clear();
  }

  async action(id, action, payload, options = {}) {
    const agent = this.get(id);
    if (!agent) return { ok: false, code: "agent_not_found", agentId: id, action, message: "agent not found" };
    const adapter = this.#adapters.get(agent.source);
    if (!adapter) return { ok: false, code: "adapter_not_found", agentId: id, action, message: "adapter not found" };

    const capability = ACTION_CAPABILITIES.get(action);
    if (!capability) return { ok: false, code: "unknown_action", agentId: id, action, message: "unknown action" };
    if (!agent.capabilities?.[capability]) {
      return { ok: false, code: "capability_not_available", agentId: id, action, message: `capability ${capability} is not available` };
    }

    let result;
    try {
      options.signal?.throwIfAborted();
      const invoke = (() => {
      switch (action) {
        case "prompt": return adapter.prompt(agent, String(payload?.text ?? ""), options);
        case "send-keys": return adapter.sendKeys(agent, payload?.keys ?? [], options);
        case "approve": return adapter.approve(agent, payload, options);
        case "reject": return adapter.reject(agent, payload, options);
        case "interrupt": return adapter.interrupt(agent, options);
        case "focus": return adapter.focus(agent, options);
        case "read": return adapter.read(agent, options);
      }
      })();
      if (!options.signal) result = await invoke;
      else result = await Promise.race([
        invoke,
        new Promise((_, reject) => options.signal.addEventListener(
          "abort", () => reject(options.signal.reason), { once: true },
        )),
      ]);
    } catch (error) {
      result = { ok: false, code: "action_failed", agentId: id, action, message: String(error?.message ?? error) };
    }
    const normalizedResult = result?.ok
      ? { ...result, ok: true, agentId: result.agentId ?? id, action: result.action ?? action }
      : result?.code
        ? {
            ...result,
            message: this.#operations?.redact?.({ message: result.message ?? "action failed" }).message
              ?? result.message
              ?? "action failed",
          }
        : {
            ...result,
            ok: false,
            code: "action_failed",
            agentId: id,
            action,
            message: this.#operations?.redact?.({ message: result?.message ?? "action failed" }).message
              ?? "action failed",
          };
    this.events.emit({
      type: "agent.action",
      agentId: id,
      action,
      ok: normalizedResult.ok,
      code: normalizedResult.code,
      snapshotRevision: this.#revision,
      at: new Date().toISOString(),
    });
    return normalizedResult;
  }
}

function historyOverlay(agents, historyAgents) {
  return agents.filter((agent) => historyAgents.has(agent.id) || matchesView(agent, "historical"));
}
