import { AgentEventBus } from "./event-bus.js";
import { isDeepStrictEqual } from "node:util";

const ACTION_CAPABILITIES = new Map([
  ["prompt", "prompt"],
  ["send-keys", "sendKeys"],
  ["approve", "approve"],
  ["reject", "reject"],
  ["interrupt", "interrupt"],
  ["focus", "focus"],
  ["read", "read"],
]);

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
  #revision = 0;
  events = new AgentEventBus();

  constructor(adapters) {
    for (const adapter of adapters) this.#adapters.set(adapter.id, adapter);
  }

  list() {
    return [...this.#agents.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }
  get(id) { return this.#agents.get(id); }
  get revision() { return this.#revision; }

  async refresh() {
    const next = new Map();
    for (const adapter of this.#adapters.values()) {
      try {
        for (const agent of await adapter.discover()) next.set(agent.id, agent);
      } catch (error) {
        console.error(`[agent-host] adapter ${adapter.id} discovery failed:`, error);
      }
    }

    const at = new Date().toISOString();
    const normalized = new Map();
    const changes = [];
    for (const [id, agent] of next) {
      const previous = this.#agents.get(id);
      if (!previous) {
        const discovered = { ...agent, discoveredAt: agent.discoveredAt ?? at, updatedAt: agent.updatedAt ?? at };
        normalized.set(id, discovered);
        changes.push({ type: "agent.discovered", agent: discovered, at });
      } else if (!isDeepStrictEqual(semanticAgent(previous), semanticAgent(agent))) {
        const updated = { ...agent, discoveredAt: previous.discoveredAt, updatedAt: at };
        normalized.set(id, updated);
        changes.push({ type: "agent.updated", agent: updated, at });
      } else {
        normalized.set(id, previous);
      }
    }
    for (const id of this.#agents.keys()) {
      if (!next.has(id)) changes.push({ type: "agent.removed", agentId: id, at });
    }
    if (changes.length) this.#revision += 1;
    this.#agents = normalized;
    for (const change of changes) this.events.emit({ ...change, snapshotRevision: this.#revision });
    return this.list();
  }

  async close() {
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close?.()));
  }

  async action(id, action, payload) {
    const agent = this.#agents.get(id);
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
