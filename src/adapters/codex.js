import { CodexRpcClient } from "./codex-rpc.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

function mapStatus(status, hasApproval) {
  if (hasApproval) return "blocked";
  switch (status?.type) {
    case "active": return "working";
    case "idle": return "idle";
    case "systemError": return "error";
    case "notLoaded": return "idle";
    default: return "unknown";
  }
}

function pendingApprovalView(entry) {
  const params = entry.message.params ?? {};
  return {
    approvalId: entry.approvalId,
    method: entry.message.method,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    reason: params.reason,
    command: params.command,
    cwd: params.cwd,
    availableDecisions: params.availableDecisions,
  };
}

export class CodexAdapter {
  id = "codex";
  #client;
  #pendingApprovals = new Map();
  #activeTurns = new Map();
  #status = new Map();
  #started = false;

  constructor(options = {}) {
    this.#client = options.client ?? new CodexRpcClient(options.rpc);
    this.#client.onServerRequest?.((message) => this.#onServerRequest(message));
    this.#client.onNotification?.((message) => this.#onNotification(message));
  }

  async discover() {
    try {
      await this.#ensureStarted();
      const threads = await this.#listThreads();
      const now = new Date().toISOString();
      return threads.map((thread) => {
        const approvals = this.#approvalsForThread(thread.id);
        const status = this.#status.get(thread.id) ?? thread.status;
        const title = thread.name ?? thread.preview ?? thread.agentNickname ?? thread.id;
        return {
          id: `codex:${thread.id}`,
          provider: "codex",
          source: this.id,
          name: String(title),
          status: mapStatus(status, approvals.length > 0),
          capabilities: {
            prompt: true,
            sendKeys: false,
            approve: approvals.length > 0,
            reject: approvals.length > 0,
            interrupt: status?.type === "active" || this.#activeTurns.has(thread.id),
            focus: false,
            read: true,
          },
          cwd: thread.cwd,
          sessionId: thread.id,
          target: thread.id,
          metadata: {
            codex: thread,
            pendingApprovals: approvals.map(pendingApprovalView),
            activeTurnId: this.#activeTurns.get(thread.id),
          },
          discoveredAt: now,
          updatedAt: now,
        };
      });
    } catch (error) {
      if (error?.code === "ENOENT" || String(error).includes("ENOENT")) return [];
      throw error;
    }
  }

  async prompt(agent, text) {
    if (!text.trim()) return this.#fail(agent, "prompt", "text is required");
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      await this.#client.request("thread/resume", { threadId });
      const activeTurnId = this.#activeTurns.get(threadId);
      const result = activeTurnId
        ? await this.#client.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{ type: "text", text }],
          })
        : await this.#client.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
          });
      const turnId = result?.turn?.id ?? result?.turnId;
      if (turnId) this.#activeTurns.set(threadId, turnId);
      return { ok: true, agentId: agent.id, action: "prompt", data: result };
    } catch (error) {
      return this.#fail(agent, "prompt", error);
    }
  }

  async approve(agent, payload = {}) {
    return this.#resolveApproval(agent, payload, "accept", "approve");
  }

  async reject(agent, payload = {}) {
    return this.#resolveApproval(agent, payload, "decline", "reject");
  }

  async interrupt(agent) {
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const turnId = this.#activeTurns.get(threadId) ?? await this.#findActiveTurn(threadId);
      if (!turnId) return this.#fail(agent, "interrupt", "no active turn found");
      const result = await this.#client.request("turn/interrupt", { threadId, turnId });
      return { ok: true, agentId: agent.id, action: "interrupt", data: result };
    } catch (error) {
      return this.#fail(agent, "interrupt", error);
    }
  }

  async read(agent) {
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const result = await this.#client.request("thread/read", { threadId, includeTurns: true });
      return { ok: true, agentId: agent.id, action: "read", data: result };
    } catch (error) {
      return this.#fail(agent, "read", error);
    }
  }

  async close() {
    await this.#client.close?.();
  }

  async #ensureStarted() {
    if (this.#started) return;
    await this.#client.start();
    this.#started = true;
  }

  async #listThreads() {
    const all = [];
    let cursor = null;
    do {
      const result = await this.#client.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
      });
      all.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
    } while (cursor && all.length < 1000);
    return all;
  }

  async #findActiveTurn(threadId) {
    const result = await this.#client.request("thread/read", { threadId, includeTurns: true });
    const turns = result?.thread?.turns ?? [];
    const active = [...turns].reverse().find((turn) => turn?.status === "inProgress" || turn?.status?.type === "inProgress");
    if (active?.id) this.#activeTurns.set(threadId, active.id);
    return active?.id;
  }

  #onServerRequest(message) {
    if (!APPROVAL_METHODS.has(message.method)) return;
    const threadId = message.params?.threadId;
    if (!threadId) return;
    const approvalId = String(message.id);
    this.#pendingApprovals.set(approvalId, { approvalId, rawId: message.id, message, receivedAt: Date.now() });
  }

  #onNotification(message) {
    const params = message.params ?? {};
    if (message.method === "thread/status/changed" && params.threadId) {
      this.#status.set(params.threadId, params.status);
    }
    if (message.method === "thread/started" && params.thread?.id) {
      this.#status.set(params.thread.id, params.thread.status);
    }
    if (message.method === "turn/started" && params.threadId && params.turn?.id) {
      this.#activeTurns.set(params.threadId, params.turn.id);
      this.#status.set(params.threadId, { type: "active", activeFlags: [] });
    }
    if (message.method === "turn/completed" && params.threadId) {
      this.#activeTurns.delete(params.threadId);
      this.#status.set(params.threadId, { type: "idle" });
      this.#clearApprovalsForThread(params.threadId);
    }
    if (message.method === "serverRequest/resolved" && params.requestId !== undefined) {
      this.#pendingApprovals.delete(String(params.requestId));
    }
  }

  #approvalsForThread(threadId) {
    return [...this.#pendingApprovals.values()].filter((entry) => entry.message.params?.threadId === threadId);
  }

  #clearApprovalsForThread(threadId) {
    for (const [id, entry] of this.#pendingApprovals) {
      if (entry.message.params?.threadId === threadId) this.#pendingApprovals.delete(id);
    }
  }

  async #resolveApproval(agent, payload, decision, action) {
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const approvals = this.#approvalsForThread(threadId);
      const requestedId = payload?.approvalId !== undefined ? String(payload.approvalId) : undefined;
      const entry = requestedId
        ? approvals.find((candidate) => candidate.approvalId === requestedId)
        : approvals.length === 1 ? approvals[0] : undefined;
      if (!entry) {
        const message = approvals.length > 1
          ? "multiple approvals are pending; pass approvalId"
          : "no matching approval is pending";
        return this.#fail(agent, action, message);
      }
      this.#client.respond(entry.rawId, { decision });
      this.#pendingApprovals.delete(entry.approvalId);
      return { ok: true, agentId: agent.id, action, data: { approvalId: entry.approvalId, decision } };
    } catch (error) {
      return this.#fail(agent, action, error);
    }
  }

  #fail(agent, action, error) {
    return { ok: false, agentId: agent.id, action, message: String(error?.message ?? error) };
  }
}
