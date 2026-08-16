import { noCapabilities } from "../core/types.js";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const ACTIVE_STATUSES = new Set(["working", "blocked"]);
const ACTION_CAPABILITIES = { prompt: "prompt", interrupt: "interrupt", approve: "approve", reject: "reject" };

function capabilities(overrides = {}) {
  return { ...noCapabilities(), ...overrides };
}

function repository(name, options = {}) {
  const host = options.host ?? "forge.example";
  const owner = options.owner ?? "example-labs";
  return {
    forge: options.forge ?? "github",
    host,
    coordinates: { kind: "named", owner, name },
    webUrl: `https://${host}/${owner}/${name}`,
    visibility: options.visibility ?? "public",
  };
}

function confirmed(name, options = {}) {
  const association = {
    kind: "confirmed",
    repository: repository(name, options),
    provenance: { source: "adapter-authoritative", confidence: "high" },
  };
  if (options.branch || options.worktreeId) {
    association.checkout = {
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.worktreeId ? { worktree: { id: options.worktreeId } } : {}),
    };
  }
  if (options.pullRequest) {
    association.pullRequest = {
      number: options.pullRequest,
      webUrl: `${association.repository.webUrl}/pull/${options.pullRequest}`,
    };
  }
  return association;
}

function repositoryContext(key) {
  if (key === "idle") return { state: "ready", associations: [] };
  if (key === "working") {
    return { state: "ready", associations: [confirmed("orbit", {
      branch: "feature/repository-context", worktreeId: "orbit-primary", pullRequest: 42,
    })] };
  }
  if (key === "blocked") {
    return {
      state: "ready",
      associations: [
        confirmed("private-orbit", { visibility: "private", branch: "secure/review" }),
        {
          kind: "candidate",
          reason: "branch_match",
          repository: repository("orbit-tools"),
          provenance: { source: "adapter-heuristic", confidence: "medium" },
          checkout: { branch: "secure/review" },
        },
      ],
    };
  }
  if (key === "done") {
    return {
      state: "ready",
      freshness: "stale",
      observedAt: "2026-01-01T00:00:03.000Z",
      associations: [confirmed("archive", { branch: "release/1.x" })],
    };
  }
  if (key === "error") {
    return { state: "unavailable", error: { code: "demo_source_unavailable", retryable: true } };
  }
  return { state: "unsupported" };
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
      repositoryContext: repositoryContext(key),
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
      repositoryContext: current.id === "demo:idle" && action === "prompt"
        ? { state: "ready", associations: [confirmed("new-context", { branch: "demo/changed" })] }
        : current.repositoryContext,
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

export class DemoLaunchAdapter {
  id = "demo-launch";
  #agents = new Map();
  #transition = 0;

  launchCapabilities() {
    return {
      provider: "demo",
      capabilityVersion: "demo-v1",
      targets: [{
        id: "demo:workspace",
        profiles: ["default"],
        modes: [
          { id: "local", enabled: true, localMutation: true, externalBillable: false },
          { id: "cloud", enabled: true, localMutation: false, externalBillable: true },
        ],
      }],
    };
  }

  async discover() { return []; }

  async launch(_request, { attemptId }) { return this.#ownedResult(attemptId); }

  async reconcileLaunch(record) { return this.#ownedResult(record.attemptId); }

  async discoverOwned(records) {
    const active = new Set();
    for (const record of records) {
      active.add(record.agentId);
      if (!this.#agents.has(record.agentId)) {
        const at = record.updatedAt;
        this.#agents.set(record.agentId, {
          id: record.agentId,
          provider: "demo",
          source: this.id,
          name: `Demo · Owned ${record.id.slice(-8)}`,
          status: "idle",
          capabilities: capabilities({ prompt: true, read: true }),
          lastActivityAt: at,
          discoveredAt: at,
          updatedAt: at,
          discovery: { kind: "native", confidence: "high", visibility: "recent", provenance: "launch-ledger" },
          pendingApprovals: [],
          metadata: { demo: true, ownedLaunch: true },
        });
      }
    }
    for (const id of this.#agents.keys()) if (!active.has(id)) this.#agents.delete(id);
    return records.map((record) => copyAgent(this.#agents.get(record.agentId)));
  }

  async prompt(agent, text) {
    return this.#transitionAgent(agent, "prompt", "working", { accepted: true, textLength: text.length });
  }

  async interrupt(agent) {
    return this.#transitionAgent(agent, "interrupt", "idle", { interrupted: true });
  }

  async read(agent) {
    return this.#agents.has(agent.id)
      ? { ok: true, agentId: agent.id, action: "read", data: { lines: [`Deterministic output for ${agent.id}`] } }
      : { ok: false, code: "agent_not_found", agentId: agent.id, action: "read", message: "demo agent not found" };
  }

  #transitionAgent(agent, action, status, data) {
    const current = this.#agents.get(agent.id);
    if (!current) {
      return { ok: false, code: "agent_not_found", agentId: agent.id, action, message: "demo agent not found" };
    }
    const capability = ACTION_CAPABILITIES[action];
    if (capability && !current.capabilities[capability]) {
      return { ok: false, code: "capability_not_available", agentId: agent.id, action, message: `capability ${capability} is not available` };
    }
    const previousStatus = current.status;
    this.#transition += 1;
    const updatedAt = new Date(BASE_TIME + 120_000 + this.#transition * 1_000).toISOString();
    const next = {
      ...current,
      status,
      lastActivityAt: updatedAt,
      updatedAt,
      capabilities: capabilities({ prompt: true, interrupt: status === "working", read: true }),
      discovery: { ...current.discovery, visibility: ACTIVE_STATUSES.has(status) ? "active" : "recent" },
    };
    this.#agents.set(agent.id, next);
    return {
      ok: true,
      agentId: agent.id,
      action,
      data: { ...data, transition: { from: previousStatus, to: status }, transitionNumber: this.#transition },
    };
  }

  #ownedResult(attemptId) {
    const suffix = String(attemptId).replace(/^attempt:/, "");
    return { status: "owned", providerAgentId: `demo-agent:${suffix}`, agentId: `demo:owned:${suffix}` };
  }
}
