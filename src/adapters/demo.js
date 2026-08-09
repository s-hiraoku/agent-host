import { noCapabilities } from "../core/types.js";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const ACTIVE_STATUSES = new Set(["working", "blocked"]);
const ACTION_CAPABILITIES = { prompt: "prompt", interrupt: "interrupt", approve: "approve", reject: "reject" };

function capabilities(overrides = {}) {
  return { ...noCapabilities(), ...overrides };
}

function initialAgents() {
  return [
    ["idle", "Idle", "idle", capabilities({ prompt: true, read: true })],
    ["working", "Working", "working", capabilities({ prompt: true, interrupt: true, read: true })],
    ["blocked", "Approval required", "blocked", capabilities({ approve: true, reject: true, read: true })],
    ["done", "Done", "done", capabilities({ read: true })],
    ["error", "Error", "error", capabilities({ prompt: true, read: true })],
    ["unknown", "Unknown", "unknown", capabilities()],
  ].map(([key, label, status, agentCapabilities], index) => {
    const at = new Date(BASE_TIME + index * 1_000).toISOString();
    return {
      id: `demo:${key}`,
      provider: "demo",
      source: "demo",
      name: `Demo · ${label}`,
      status,
      capabilities: agentCapabilities,
      lastActivityAt: at,
      discoveredAt: at,
      updatedAt: at,
      discovery: {
        kind: "native",
        confidence: "high",
        visibility: ACTIVE_STATUSES.has(status) ? "active" : "recent",
      },
      pendingApprovals: key === "blocked" ? [{
        approvalId: "demo-approval-1",
        method: "demo/requestApproval",
        reason: "Exercise the dashboard approval flow",
        command: "demo-check --safe",
        availableDecisions: ["accept", "decline"],
      }] : [],
      metadata: { demo: true },
    };
  });
}

function copyAgent(agent) {
  return structuredClone(agent);
}

export class DemoAdapter {
  id = "demo";
  #agents = new Map(initialAgents().map((agent) => [agent.id, agent]));
  #transition = 0;

  async discover() {
    return [...this.#agents.values()].map(copyAgent);
  }

  async prompt(agent, text) {
    return this.#transitionAgent(agent, "prompt", "working", {
      accepted: true,
      textLength: text.length,
    });
  }

  async interrupt(agent) {
    return this.#transitionAgent(agent, "interrupt", "idle", { interrupted: true });
  }

  async approve(agent, payload = {}) {
    return this.#resolveApproval(agent, "approve", payload, "working", "accept");
  }

  async reject(agent, payload = {}) {
    return this.#resolveApproval(agent, "reject", payload, "done", "decline");
  }

  async read(agent) {
    return {
      ok: true,
      agentId: agent.id,
      action: "read",
      data: { lines: [`Deterministic output for ${agent.id}`] },
    };
  }

  #resolveApproval(agent, action, payload, status, decision) {
    const current = this.#agents.get(agent.id);
    const approval = current?.pendingApprovals?.[0];
    if (!approval || (payload.approvalId && payload.approvalId !== approval.approvalId)) {
      return {
        ok: false,
        code: "approval_not_found",
        agentId: agent.id,
        action,
        message: "demo approval not found",
      };
    }
    return this.#transitionAgent(agent, action, status, { approvalId: approval.approvalId, decision });
  }

  #transitionAgent(agent, action, status, data) {
    const current = this.#agents.get(agent.id);
    if (!current) {
      return { ok: false, code: "agent_not_found", agentId: agent.id, action, message: "demo agent not found" };
    }
    const capability = ACTION_CAPABILITIES[action];
    if (capability && !current.capabilities[capability]) {
      return {
        ok: false,
        code: "capability_not_available",
        agentId: agent.id,
        action,
        message: `capability ${capability} is not available`,
      };
    }
    const previousStatus = current.status;
    this.#transition += 1;
    const updatedAt = new Date(BASE_TIME + 60_000 + this.#transition * 1_000).toISOString();
    const next = {
      ...current,
      status,
      lastActivityAt: updatedAt,
      updatedAt,
      pendingApprovals: [],
      capabilities: capabilities({
        prompt: status === "idle" || status === "working" || status === "error",
        interrupt: status === "working",
        read: status !== "unknown",
      }),
      discovery: {
        ...current.discovery,
        visibility: ACTIVE_STATUSES.has(status) ? "active" : "recent",
      },
    };
    this.#agents.set(agent.id, next);
    return {
      ok: true,
      agentId: agent.id,
      action,
      data: { ...data, transition: { from: previousStatus, to: status }, transitionNumber: this.#transition },
    };
  }
}
