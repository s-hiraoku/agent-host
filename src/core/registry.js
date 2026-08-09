import { AgentEventBus } from "./event-bus.js";
import { isDeepStrictEqual } from "node:util";
import { compareAgents, matchesView, reconcileAgents } from "./discovery.js";

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
  };
}

function semanticAgent(agent) {
  const {
    discoveredAt: _discoveredAt,
    updatedAt: _updatedAt,
    metadata: _metadata,
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
  #historyExpiresAt = 0;
  #historyPromise;
  #historyControllers = new Set();
  #closeController = new AbortController();
  #closedOutcome;
  #refreshPromise;
  #initialLoading = true;
  #closed = false;
  #revision = 0;
  events = new AgentEventBus();

  constructor(adapters, options = {}) {
    this.#adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    this.#historyTtlMs = options.historyTtlMs ?? DEFAULT_HISTORY_TTL_MS;
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
      });
    }
  }

  list() {
    return reconcileAgents([...this.#agents.values()]).sort(compareAgents);
  }
  listRaw() { return reconcileAgents([...this.#agents.values()], true).sort(compareAgents); }
  async listView(view = "recent") {
    if (view !== "historical" && view !== "raw") {
      return { agents: this.list().filter((agent) => matchesView(agent, view)), cursorRevision: this.#revision };
    }
    await this.#loadHistory();
    if (view === "historical") {
      return {
        agents: reconcileAgents([...this.#historyAgents.values()]).filter((agent) => matchesView(agent, view)).sort(compareAgents),
        cursorRevision: `history:${this.#historyRevision}`,
      };
    }
    const combined = new Map(this.#historyAgents);
    for (const agent of this.listRaw()) combined.set(agent.id, agent);
    return {
      agents: reconcileAgents([...combined.values()], true).sort(compareAgents),
      cursorRevision: `raw:${this.#revision}:${this.#historyRevision}`,
    };
  }
  get(id) { return this.listRaw().find((agent) => agent.id === id) ?? this.#historyAgents.get(id); }
  get revision() { return this.#revision; }
  get initialLoading() { return this.#initialLoading; }
  get refreshing() { return Boolean(this.#refreshPromise); }
  get closed() { return this.#closed; }
  adapterHealth() {
    return [...this.#adapterHealth.values()].map((health) => ({
      ...health,
      error: health.error ? { ...health.error } : null,
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

  refresh() {
    if (this.#closed) return Promise.resolve(this.list());
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#runRefresh().finally(() => {
      this.#initialLoading = false;
      this.#refreshPromise = undefined;
    });
    return this.#refreshPromise;
  }

  async #runRefresh() {
    await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        const outcome = await this.#discoverAdapter(adapter);
        if (!this.#closed) this.#applyOutcome(outcome);
      }),
    );
    return this.list();
  }

  #applyOutcome(outcome) {
    const previousCanonical = new Map(this.list().map((agent) => [agent.id, agent]));
    const next = new Map(this.#agents);
    const previousHealth = this.#adapterHealth.get(outcome.adapterId);
    const health = this.#healthForOutcome(previousHealth, outcome);
    this.#adapterHealth.set(outcome.adapterId, health);
    const healthChanged = !isDeepStrictEqual(semanticHealth(previousHealth), semanticHealth(health));

    if (outcome.status === "success") {
      for (const [id, agent] of next) {
        if (agent.source === outcome.adapterId) next.delete(id);
      }
      for (const agent of outcome.agents) next.set(agent.id, agent);
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
      } else {
        normalized.set(id, previous);
      }
    }
    this.#agents = normalized;
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
    if (healthChanged) {
      this.events.emit({
        type: "adapter.health",
        adapter: { ...health },
        at: new Date().toISOString(),
        snapshotRevision: this.#revision,
      });
    }
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
      for (const result of results) {
        if (!result.agents) continue;
        for (const [id, agent] of next) {
          if (agent.source === result.adapterId) next.delete(id);
        }
        for (const agent of result.agents) next.set(agent.id, agent);
      }
      const before = [...this.#historyAgents.values()].map(semanticAgent).sort((a, b) => a.id.localeCompare(b.id));
      const after = [...next.values()].map(semanticAgent).sort((a, b) => a.id.localeCompare(b.id));
      if (!isDeepStrictEqual(before, after)) this.#historyRevision += 1;
      this.#historyAgents = next;
      this.#historyExpiresAt = Date.now() + this.#historyTtlMs;
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
    if (outcome.status === "success") {
      return {
        id: outcome.adapterId,
        status: "healthy",
        lastAttemptAt: outcome.attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        durationMs: outcome.durationMs,
        agentCount: outcome.agents.length,
        error: null,
      };
    }
    const error = outcome.status === "timeout"
      ? { code: "discovery_timeout", message: `discovery exceeded ${this.#adapterTimeoutMs}ms` }
      : sanitizeError(outcome.error);
    return {
      ...previous,
      status: outcome.status,
      lastAttemptAt: outcome.attemptedAt,
      durationMs: outcome.durationMs,
      error,
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort();
    for (const flight of this.#adapterFlights.values()) flight.controller.abort();
    for (const controller of this.#historyControllers) controller.abort();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close?.()));
    await Promise.allSettled([this.#refreshPromise, this.#historyPromise].filter(Boolean));
    this.#adapterFlights.clear();
    this.#historyControllers.clear();
  }

  async action(id, action, payload) {
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
      switch (action) {
        case "prompt": result = await adapter.prompt(agent, String(payload?.text ?? "")); break;
        case "send-keys": result = await adapter.sendKeys(agent, payload?.keys ?? []); break;
        case "approve": result = await adapter.approve(agent, payload); break;
        case "reject": result = await adapter.reject(agent, payload); break;
        case "interrupt": result = await adapter.interrupt(agent); break;
        case "focus": result = await adapter.focus(agent); break;
        case "read": result = await adapter.read(agent); break;
      }
    } catch (error) {
      result = { ok: false, code: "action_failed", agentId: id, action, message: String(error?.message ?? error) };
    }
    const normalizedResult = result?.ok
      ? { ...result, ok: true, agentId: result.agentId ?? id, action: result.action ?? action }
      : result?.code
        ? result
        : { ...result, ok: false, code: "action_failed", agentId: id, action, message: result?.message ?? "action failed" };
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
