import { AgentEventBus } from "./event-bus.js";

export class AgentRegistry {
  #agents = new Map();
  #adapters = new Map();
  events = new AgentEventBus();

  constructor(adapters) {
    for (const adapter of adapters) this.#adapters.set(adapter.id, adapter);
  }

  list() { return [...this.#agents.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { return this.#agents.get(id); }

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
    for (const [id, agent] of next) {
      const previous = this.#agents.get(id);
      if (!previous) this.events.emit({ type: "agent.discovered", agent, at });
      else if (JSON.stringify(previous) !== JSON.stringify(agent)) this.events.emit({ type: "agent.updated", agent, at });
    }
    for (const id of this.#agents.keys()) {
      if (!next.has(id)) this.events.emit({ type: "agent.removed", agentId: id, at });
    }
    this.#agents = next;
    return this.list();
  }

  async close() {
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close?.()));
  }

  async action(id, action, payload) {
    const agent = this.#agents.get(id);
    if (!agent) return { ok: false, agentId: id, action, message: "agent not found" };
    const adapter = this.#adapters.get(agent.source);
    if (!adapter) return { ok: false, agentId: id, action, message: "adapter not found" };

    const capability = action === "send-keys" ? "sendKeys" : action;
    if (!agent.capabilities?.[capability]) {
      return { ok: false, agentId: id, action, message: `capability ${capability} is not available` };
    }

    let result;
    switch (action) {
      case "prompt": result = await adapter.prompt(agent, String(payload?.text ?? "")); break;
      case "send-keys": result = await adapter.sendKeys(agent, payload?.keys ?? []); break;
      case "approve": result = await adapter.approve(agent, payload); break;
      case "reject": result = await adapter.reject(agent, payload); break;
      case "interrupt": result = await adapter.interrupt(agent); break;
      case "focus": result = await adapter.focus(agent); break;
      case "read": result = await adapter.read(agent); break;
      default: result = { ok: false, agentId: id, action, message: "unknown action" };
    }
    this.events.emit({ type: "agent.action", agentId: id, action, ok: result.ok, at: new Date().toISOString() });
    return result;
  }
}
