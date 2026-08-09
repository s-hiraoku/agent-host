import { CodexRpcClient } from "./codex-rpc.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/aborted"]);

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
  #approvalTimeoutMs;

  constructor(options = {}) {
    this.#client = options.client ?? new CodexRpcClient(options.rpc);
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#client.onServerRequest?.((message) => this.#onServerRequest(message));
    this.#client.onNotification?.((message) => this.#onNotification(message));
  }

  async discover(options = {}) {
    try {
      options.signal?.throwIfAborted();
      await this.#ensureStarted();
      options.signal?.throwIfAborted();
      const threads = await this.#listThreads(options.signal);
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
          activeTurnId: this.#activeTurns.get(thread.id),
          pendingApprovals: approvals.map(pendingApprovalView),
          metadata: {
            codex: thread,
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
      let result;
      if (activeTurnId) {
        try {
          result = await this.#client.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{ type: "text", text }],
          });
        } catch {
          this.#activeTurns.delete(threadId);
          result = await this.#client.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
          });
        }
      } else {
        result = await this.#client.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
        });
      }
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
      this.#activeTurns.delete(threadId);
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
    try { await this.#client.close?.(); }
    finally {
      this.#started = false;
      for (const entry of this.#pendingApprovals.values()) clearTimeout(entry.timer);
      this.#pendingApprovals.clear();
      this.#activeTurns.clear();
    }
  }

  async #ensureStarted() {
    if (this.#started) return;
    await this.#client.start();
    this.#started = true;
  }

  async #listThreads(signal) {
    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const result = await this.#client.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
      }, { signal });
      all.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
      pages += 1;
    } while (cursor && all.length < 1000 && pages < 20);
    return all;
  }

  async #findActiveTurn(threadId) {
    const result = await this.#client.request("thread/read", { threadId, includeTurns: true });
    const turns = result?.thread?.turns ?? [];
    const active = turns.findLast((turn) => turn?.status === "inProgress" || turn?.status?.type === "inProgress");
    if (active?.id) this.#activeTurns.set(threadId, active.id);
    return active?.id;
  }

  #onServerRequest(message) {
    if (!APPROVAL_METHODS.has(message.method)) {
      this.#client.respondError?.(message.id, -32601, `Unsupported server request: ${message.method}`);
      return;
    }
    const threadId = message.params?.threadId;
    if (!threadId) {
      this.#client.respondError?.(message.id, -32602, "Approval request is missing threadId");
      return;
    }
    const approvalId = String(message.id);
    this.#deleteApproval(approvalId);
    const entry = { approvalId, rawId: message.id, message, receivedAt: Date.now() };
    entry.timer = setTimeout(() => {
      if (this.#pendingApprovals.get(approvalId) !== entry) return;
      try { this.#client.respond(entry.rawId, { decision: "cancel" }); }
      catch {}
      finally { this.#pendingApprovals.delete(approvalId); }
    }, this.#approvalTimeoutMs);
    entry.timer.unref?.();
    this.#pendingApprovals.set(approvalId, entry);
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
    if (TERMINAL_TURN_METHODS.has(message.method) && params.threadId) {
      this.#activeTurns.delete(params.threadId);
      const failed = params.turn?.status === "failed" || message.method === "turn/failed";
      this.#status.set(params.threadId, { type: failed ? "systemError" : "idle" });
      this.#clearApprovalsForThread(params.threadId);
    }
    if (message.method === "serverRequest/resolved" && params.requestId !== undefined) {
      this.#deleteApproval(String(params.requestId));
    }
  }

  #approvalsForThread(threadId) {
    return [...this.#pendingApprovals.values()].filter((entry) => entry.message.params?.threadId === threadId);
  }

  #clearApprovalsForThread(threadId) {
    for (const [id, entry] of this.#pendingApprovals) {
      if (entry.message.params?.threadId === threadId) this.#deleteApproval(id);
    }
  }

  #deleteApproval(id) {
    const entry = this.#pendingApprovals.get(id);
    if (entry) clearTimeout(entry.timer);
    this.#pendingApprovals.delete(id);
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
        const message = requestedId === undefined && approvals.length > 1
          ? "multiple approvals are pending; pass approvalId"
          : "no matching approval is pending";
        return this.#fail(agent, action, message);
      }
      this.#client.respond(entry.rawId, { decision });
      this.#deleteApproval(entry.approvalId);
      return { ok: true, agentId: agent.id, action, data: { approvalId: entry.approvalId, decision } };
    } catch (error) {
      return this.#fail(agent, action, error);
    }
  }

  #fail(agent, action, error) {
    return { ok: false, agentId: agent.id, action, message: String(error?.message ?? error) };
  }
}
