import { CodexRpcClient } from "./codex-rpc.js";
import { noCapabilities } from "../core/types.js";
import { isDeepStrictEqual } from "node:util";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RECENT_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_RECENT_LIMIT = 100;
const MAX_HISTORY_THREADS = 1_000;
const MAX_FILE_CHANGE_CONTEXTS = 256;
const MAX_APPROVAL_FILES = 20;
const MAX_THREAD_CWDS = 1_000;
const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/aborted"]);

function mapStatus(status, hasApproval) {
  if (hasApproval) return "blocked";
  switch (status?.type) {
    case "active": return "working";
    case "idle": return "idle";
    case "systemError": return "error";
    case "notLoaded": return "unknown";
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
    context: entry.context,
    actionable: entry.actionable,
  };
}

function publicFilePath(value, cwd) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const raw = value;
  const rawSegments = sep === "\\" ? raw.split(/[\\/]/) : raw.split("/");
  if (rawSegments.includes("..")) return undefined;
  let candidate = raw;
  if (isAbsolute(raw)) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
    candidate = relative(resolve(cwd), resolve(raw));
  }
  const normalized = normalize(candidate).split(sep).join("/");
  if (!normalized || normalized === ".") return basename(raw).slice(0, 240) || undefined;
  if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    return undefined;
  }
  if (normalized.length > 240) return undefined;
  return normalized;
}

function fileChangeContext(item, cwd) {
  if (item?.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) return undefined;
  const validated = item.changes.flatMap((change) => {
    const path = publicFilePath(change?.path, cwd);
    if (!path) return [];
    const kind = ["add", "delete", "update"].includes(change?.kind) ? change.kind : "update";
    return [{ path, kind }];
  });
  if (validated.length !== item.changes.length) return undefined;
  const files = validated.slice(0, MAX_APPROVAL_FILES);
  return {
    kind: "file-change",
    fileCount: item.changes.length,
    files,
    truncated: item.changes.length > files.length,
  };
}

function contextKey(generation, threadId, turnId, itemId) {
  return JSON.stringify([generation, threadId, turnId, itemId]);
}

export class CodexAdapter {
  id = "codex";
  #client;
  #pendingApprovals = new Map();
  #activeTurns = new Map();
  #status = new Map();
  #started = false;
  #approvalTimeoutMs;
  #now;
  #recentMs;
  #mode;
  #connectionGeneration = 0;
  #subscriptions = new Map();
  #directInput = new Map();
  #loadedThreads = new Map();
  #threadCwds = new Map();
  #fileChangeContexts = new Map();
  #changeHandlers = new Set();

  constructor(options = {}) {
    this.#mode = options.mode ?? "owned";
    this.#client = options.client ?? new CodexRpcClient(options.rpc);
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#recentMs = options.recentMs ?? DEFAULT_RECENT_MS;
    this.#client.onServerRequest?.((message) => this.#onServerRequest(message));
    this.#client.onNotification?.((message) => this.#onNotification(message));
    this.#client.onStateChange?.((event) => this.#onStateChange(event));
  }

  onChange(handler) {
    this.#changeHandlers.add(handler);
    return () => this.#changeHandlers.delete(handler);
  }

  async discover(options = {}) {
    try {
      options.signal?.throwIfAborted();
      await this.#ensureStarted();
      options.signal?.throwIfAborted();
      const generation = this.#connectionGeneration;
      if (this.#mode === "control") await this.#syncLoadedThreads(options.signal);
      const threads = await this.#listThreads(DEFAULT_RECENT_LIMIT, options.signal);
      if (this.#mode === "control" && generation !== this.#connectionGeneration) {
        throw new Error("Codex control connection changed during discovery");
      }
      if (this.#mode === "control") {
        const known = new Set(threads.map((thread) => thread.id));
        for (const thread of this.#subscribedThreadRecords()) {
          if (!known.has(thread.id)) threads.push(thread);
        }
      }
      const now = new Date().toISOString();
      return threads.map((thread) => this.#mapThread(thread, now));
    } catch (error) {
      if (error?.code === "ENOENT" || String(error).includes("ENOENT")) return [];
      throw error;
    }
  }

  async discoverHistory(options = {}) {
    options.signal?.throwIfAborted();
    await this.#ensureStarted();
    const threads = await this.#listThreads(MAX_HISTORY_THREADS, options.signal);
    const now = new Date().toISOString();
    return threads.map((thread) => this.#mapThread(thread, now));
  }

  #mapThread(thread, now) {
    this.#rememberThreadCwd(thread.id, thread.cwd);
    const approvals = this.#approvalsForThread(thread.id);
    const actionableApprovals = approvals.filter((entry) => entry.actionable);
    const status = this.#status.get(thread.id) ?? thread.status;
    const title = thread.name ?? thread.preview ?? thread.agentNickname ?? thread.id;
    const lastActivityAt = codexTimestamp(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt);
    const mappedStatus = mapStatus(status, approvals.length > 0);
    const controllable = this.#mode === "owned"
      || this.#subscriptions.get(thread.id) === this.#connectionGeneration;
    const canPrompt = this.#mode === "owned" || (controllable && this.#directInput.get(thread.id) === true);
    return {
      id: `codex:${thread.id}`,
      provider: "codex",
      source: this.id,
      name: String(title),
      status: mappedStatus,
      capabilities: {
        prompt: canPrompt,
        sendKeys: false,
        approve: controllable && actionableApprovals.length > 0,
        reject: controllable && actionableApprovals.length > 0,
        interrupt: controllable && (status?.type === "active" || this.#activeTurns.has(thread.id)),
        focus: false,
        read: controllable,
      },
      cwd: thread.cwd,
      sessionId: thread.id,
      target: thread.id,
      activeTurnId: this.#activeTurns.get(thread.id),
      pendingApprovals: approvals.map(pendingApprovalView),
      lastActivityAt,
      discovery: {
        kind: "native",
        confidence: "high",
        provenance: this.#mode === "control" ? "shared-control-socket" : "owned-app-server",
        visibility: mappedStatus === "working" || mappedStatus === "blocked"
          ? "active"
          : !lastActivityAt || this.#now() - Date.parse(lastActivityAt) <= this.#recentMs
            ? "recent"
            : "historical",
      },
      metadata: {
        codex: thread,
        ...(this.#mode === "control" ? { transportGeneration: this.#connectionGeneration } : {}),
      },
      discoveredAt: now,
      updatedAt: now,
    };
  }

  async prompt(agent, text, options = {}) {
    if (!text.trim()) return this.#fail(agent, "prompt", "text is required");
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const generation = this.#assertControllable(threadId, "prompt");
      if (this.#mode === "owned") await this.#client.request("thread/resume", { threadId }, { signal: options.signal });
      const activeTurnId = this.#activeTurns.get(threadId) ?? await this.#findActiveTurn(threadId, generation, options.signal);
      let result;
      if (activeTurnId) {
        try {
          result = await this.#client.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{ type: "text", text }],
          }, this.#actionOptions(generation, options.signal));
        } catch (error) {
          if (options.signal?.aborted) throw error;
          this.#activeTurns.delete(threadId);
          if (this.#mode === "control") throw error;
          result = await this.#client.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
          }, this.#actionOptions(generation, options.signal));
        }
      } else {
        result = await this.#client.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
        }, this.#actionOptions(generation, options.signal));
      }
      const turnId = result?.turn?.id ?? result?.turnId;
      if (turnId) this.#activeTurns.set(threadId, turnId);
      return { ok: true, agentId: agent.id, action: "prompt", data: result };
    } catch (error) {
      return this.#fail(agent, "prompt", error);
    }
  }

  async approve(agent, payload = {}, options = {}) {
    return this.#resolveApproval(agent, payload, "accept", "approve", options);
  }

  async reject(agent, payload = {}, options = {}) {
    return this.#resolveApproval(agent, payload, "decline", "reject", options);
  }

  async interrupt(agent, options = {}) {
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const generation = this.#assertControllable(threadId, "interrupt");
      const turnId = this.#activeTurns.get(threadId) ?? await this.#findActiveTurn(threadId, generation, options.signal);
      if (!turnId) return this.#fail(agent, "interrupt", "no active turn found");
      const result = await this.#client.request(
        "turn/interrupt",
        { threadId, turnId },
        this.#actionOptions(generation, options.signal),
      );
      this.#activeTurns.delete(threadId);
      return { ok: true, agentId: agent.id, action: "interrupt", data: result };
    } catch (error) {
      return this.#fail(agent, "interrupt", error);
    }
  }

  async read(agent, options = {}) {
    try {
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      const generation = this.#assertControllable(threadId, "read");
      const result = await this.#client.request(
        "thread/read",
        { threadId, includeTurns: true },
        this.#actionOptions(generation, options.signal),
      );
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
      this.#status.clear();
      this.#subscriptions.clear();
      this.#directInput.clear();
      this.#loadedThreads.clear();
      this.#threadCwds.clear();
      this.#fileChangeContexts.clear();
    }
  }

  async #ensureStarted() {
    if (this.#started) return;
    await this.#client.start();
    this.#started = true;
    this.#connectionGeneration = this.#client.generation ?? (this.#connectionGeneration || 1);
  }

  async #syncLoadedThreads(signal) {
    const generation = this.#connectionGeneration;
    const loaded = [];
    let cursor = null;
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.#client.request(
        "thread/loaded/list",
        cursor ? { cursor } : {},
        { signal },
      );
      loaded.push(...(result?.data ?? result?.threads ?? []));
      cursor = result?.nextCursor ?? null;
      if (!cursor) {
        complete = true;
        break;
      }
    }
    const loadedIds = new Set(loaded.map(loadedThreadId).filter(Boolean));
    for (const threadId of complete ? [...this.#subscriptions.keys()] : []) {
      if (!loadedIds.has(threadId)) {
        this.#subscriptions.delete(threadId);
        this.#directInput.delete(threadId);
        this.#loadedThreads.delete(threadId);
        this.#threadCwds.delete(threadId);
        this.#clearApprovalsForThread(threadId);
        this.#clearFileContextsForThread(threadId);
        this.#status.delete(threadId);
        this.#activeTurns.delete(threadId);
      }
    }
    for (const summary of loaded) {
      const threadId = loadedThreadId(summary);
      if (!threadId) continue;
      if (this.#subscriptions.get(threadId) === generation) {
        if (typeof summary === "object") this.#rememberThread(summary.thread ?? summary, false);
        continue;
      }
      this.#subscriptions.set(threadId, generation);
      try {
        const resumed = await this.#client.request("thread/resume", {
          threadId,
          excludeTurns: true,
        }, { signal });
        if (generation !== this.#connectionGeneration) return;
        this.#rememberThread(resumed?.thread ?? (typeof summary === "object" ? summary.thread ?? summary : undefined));
      } catch (error) {
        this.#subscriptions.delete(threadId);
        this.#directInput.delete(threadId);
        this.#loadedThreads.delete(threadId);
        this.#threadCwds.delete(threadId);
        this.#clearApprovalsForThread(threadId);
        this.#clearFileContextsForThread(threadId);
        this.#status.delete(threadId);
        this.#activeTurns.delete(threadId);
        signal?.throwIfAborted();
        if (generation !== this.#connectionGeneration) throw error;
      }
    }
  }

  #subscribedThreadRecords() {
    const records = [];
    for (const [threadId, generation] of this.#subscriptions) {
      if (generation !== this.#connectionGeneration) continue;
      records.push({
        ...this.#loadedThreads.get(threadId),
        id: threadId,
        status: this.#status.get(threadId) ?? this.#loadedThreads.get(threadId)?.status ?? { type: "idle" },
      });
    }
    return records;
  }

  #rememberThread(thread, rememberStatus = true) {
    const threadId = loadedThreadId(thread);
    if (!threadId) return;
    const normalized = { ...thread, id: threadId };
    this.#loadedThreads.set(threadId, { ...this.#loadedThreads.get(threadId), ...normalized });
    this.#rememberThreadCwd(threadId, thread.cwd);
    if (rememberStatus && thread.status) this.#status.set(threadId, thread.status);
    if (thread.canAcceptDirectInput !== undefined) {
      this.#directInput.set(threadId, Boolean(thread.canAcceptDirectInput));
    }
  }

  #rememberThreadCwd(threadId, cwd) {
    if (typeof cwd !== "string" || !cwd) return;
    this.#threadCwds.delete(threadId);
    this.#threadCwds.set(threadId, cwd);
    while (this.#threadCwds.size > MAX_THREAD_CWDS) {
      this.#threadCwds.delete(this.#threadCwds.keys().next().value);
    }
  }

  async #listThreads(maxThreads, signal) {
    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const result = await this.#client.request("thread/list", {
        cursor,
        limit: Math.min(100, maxThreads - all.length),
        sortKey: "recency_at",
        sortDirection: "desc",
      }, { signal });
      all.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
      pages += 1;
    } while (cursor && all.length < maxThreads && pages < Math.ceil(maxThreads / 100));
    return all.slice(0, maxThreads);
  }

  async #findActiveTurn(threadId, generation, signal) {
    const result = await this.#client.request(
      "thread/read",
      { threadId, includeTurns: true },
      this.#actionOptions(generation, signal),
    );
    this.#rememberThread(result?.thread);
    const turns = result?.thread?.turns ?? [];
    const active = turns.findLast((turn) => turn?.status === "inProgress" || turn?.status?.type === "inProgress");
    if (active?.id) this.#activeTurns.set(threadId, active.id);
    return active?.id;
  }

  #onServerRequest(message) {
    const generation = message.connectionGeneration ?? this.#connectionGeneration;
    if (generation !== this.#connectionGeneration) return;
    if (!APPROVAL_METHODS.has(message.method)) {
      if (this.#mode === "owned") {
        this.#client.respondError?.(message.id, -32601, `Unsupported server request: ${message.method}`);
      }
      return;
    }
    const threadId = message.params?.threadId;
    if (!threadId) {
      if (this.#mode === "owned") {
        this.#client.respondError?.(message.id, -32602, "Approval request is missing threadId");
      }
      return;
    }
    if (this.#mode === "control" && this.#subscriptions.get(threadId) !== generation) {
      return;
    }
    const approvalId = this.#mode === "control"
      ? `${generation}:${threadId}:${message.id}`
      : String(message.id);
    this.#deleteApproval(approvalId);
    const context = message.method === "item/fileChange/requestApproval"
      ? this.#fileChangeContexts.get(contextKey(
        generation, threadId, message.params?.turnId, message.params?.itemId,
      ))
      : undefined;
    const entry = {
      approvalId,
      rawId: message.id,
      generation,
      message,
      receivedAt: Date.now(),
      context,
      actionable: message.method !== "item/fileChange/requestApproval" || Boolean(context),
    };
    entry.timer = setTimeout(() => {
      if (this.#pendingApprovals.get(approvalId) !== entry) return;
      try {
        if (this.#mode === "owned" && entry.generation === this.#connectionGeneration) {
          this.#client.respond(entry.rawId, { decision: "cancel" });
        }
      }
      catch {}
      finally {
        this.#pendingApprovals.delete(approvalId);
        this.#emitChange();
      }
    }, this.#approvalTimeoutMs);
    entry.timer.unref?.();
    this.#pendingApprovals.set(approvalId, entry);
    this.#emitChange();
  }

  #onNotification(message) {
    const generation = message.connectionGeneration ?? this.#connectionGeneration;
    if (generation !== this.#connectionGeneration) return;
    const params = message.params ?? {};
    const threadId = params.threadId ?? params.thread?.id;
    let changed = false;
    if (this.#mode === "control" && threadId
      && this.#subscriptions.get(threadId) !== generation) return;
    if ((message.method === "item/started" || message.method === "item/completed") && threadId) {
      const context = fileChangeContext(params.item, this.#threadCwds.get(threadId));
      if (context && params.item?.id) {
        const key = contextKey(generation, threadId, params.turnId, params.item.id);
        this.#fileChangeContexts.delete(key);
        this.#fileChangeContexts.set(key, context);
        while (this.#fileChangeContexts.size > MAX_FILE_CHANGE_CONTEXTS) {
          this.#fileChangeContexts.delete(this.#fileChangeContexts.keys().next().value);
        }
        for (const entry of this.#pendingApprovals.values()) {
          if (entry.message.method === "item/fileChange/requestApproval"
            && entry.message.params?.threadId === threadId
            && entry.message.params?.turnId === params.turnId
            && entry.message.params?.itemId === params.item.id) {
            entry.context = context;
            entry.actionable = true;
            changed = true;
          }
        }
      }
    }
    if (message.method === "thread/status/changed" && params.threadId) {
      changed = !isDeepStrictEqual(this.#status.get(params.threadId), params.status);
      this.#status.set(params.threadId, params.status);
    }
    if (message.method === "thread/started" && params.thread?.id) {
      const previousThread = this.#loadedThreads.get(params.thread.id);
      const previousStatus = this.#status.get(params.thread.id);
      const previousDirectInput = this.#directInput.get(params.thread.id);
      this.#rememberThread(params.thread);
      changed = changed
        || !isDeepStrictEqual(previousThread, this.#loadedThreads.get(params.thread.id))
        || !isDeepStrictEqual(previousStatus, this.#status.get(params.thread.id))
        || previousDirectInput !== this.#directInput.get(params.thread.id);
    }
    if (message.method === "turn/started" && params.threadId && params.turn?.id) {
      const activeStatus = { type: "active", activeFlags: [] };
      changed = changed
        || this.#activeTurns.get(params.threadId) !== params.turn.id
        || !isDeepStrictEqual(this.#status.get(params.threadId), activeStatus);
      this.#activeTurns.set(params.threadId, params.turn.id);
      this.#status.set(params.threadId, activeStatus);
    }
    if (TERMINAL_TURN_METHODS.has(message.method) && params.threadId) {
      const nextStatus = {
        type: params.turn?.status === "failed" || message.method === "turn/failed" ? "systemError" : "idle",
      };
      const approvalCount = this.#pendingApprovals.size;
      changed = changed
        || this.#activeTurns.has(params.threadId)
        || !isDeepStrictEqual(this.#status.get(params.threadId), nextStatus);
      this.#activeTurns.delete(params.threadId);
      this.#status.set(params.threadId, nextStatus);
      this.#clearApprovalsForThread(params.threadId);
      this.#clearFileContextsForThread(params.threadId);
      changed = changed || approvalCount !== this.#pendingApprovals.size;
    }
    if (message.method === "serverRequest/resolved" && params.requestId !== undefined) {
      for (const [approvalId, entry] of this.#pendingApprovals) {
        if (entry.generation === generation && String(entry.rawId) === String(params.requestId)) {
          changed = this.#deleteApproval(approvalId) || changed;
        }
      }
    }
    if (changed) this.#emitChange();
  }

  #onStateChange(event) {
    if (event.state === "connected") {
      if (event.generation !== this.#connectionGeneration) this.#clearConnectionState();
      this.#connectionGeneration = event.generation;
      this.#started = true;
      return;
    }
    if (event.state !== "disconnected" || event.generation !== this.#connectionGeneration) return;
    this.#started = false;
    this.#clearConnectionState();
    this.#emitChange({ type: "disconnected", error: event.error });
  }

  #clearConnectionState() {
    for (const entry of this.#pendingApprovals.values()) clearTimeout(entry.timer);
    this.#pendingApprovals.clear();
    this.#subscriptions.clear();
    this.#directInput.clear();
    this.#loadedThreads.clear();
    this.#threadCwds.clear();
    this.#fileChangeContexts.clear();
    this.#activeTurns.clear();
    this.#status.clear();
  }

  #approvalsForThread(threadId) {
    return [...this.#pendingApprovals.values()].filter((entry) => entry.message.params?.threadId === threadId);
  }

  #clearApprovalsForThread(threadId) {
    for (const [id, entry] of this.#pendingApprovals) {
      if (entry.message.params?.threadId === threadId) this.#deleteApproval(id);
    }
  }

  #clearFileContextsForThread(threadId) {
    for (const key of this.#fileChangeContexts.keys()) {
      if (JSON.parse(key)[1] === threadId) this.#fileChangeContexts.delete(key);
    }
  }

  #deleteApproval(id) {
    const entry = this.#pendingApprovals.get(id);
    if (entry) clearTimeout(entry.timer);
    return this.#pendingApprovals.delete(id);
  }

  async #resolveApproval(agent, payload, decision, action, options) {
    try {
      options.signal?.throwIfAborted();
      await this.#ensureStarted();
      const threadId = agent.sessionId ?? agent.target;
      this.#assertControllable(threadId, action);
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
      if (entry.generation !== this.#connectionGeneration) {
        this.#deleteApproval(entry.approvalId);
        return this.#fail(agent, action, "approval belongs to a stale connection");
      }
      if (!entry.actionable) {
        return this.#fail(agent, action, "file-change approval is unavailable without sanitized file context");
      }
      this.#client.respond(entry.rawId, { decision });
      this.#deleteApproval(entry.approvalId);
      this.#fileChangeContexts.delete(contextKey(
        entry.generation, threadId, entry.message.params?.turnId, entry.message.params?.itemId,
      ));
      this.#emitChange();
      return { ok: true, agentId: agent.id, action, data: { approvalId: entry.approvalId, decision } };
    } catch (error) {
      return this.#fail(agent, action, error);
    }
  }

  #fail(agent, action, error) {
    return { ok: false, agentId: agent.id, action, message: String(error?.message ?? error) };
  }

  #assertControllable(threadId, action, expectedGeneration = this.#connectionGeneration) {
    if (this.#mode !== "control") return undefined;
    if (!this.#started || expectedGeneration !== this.#connectionGeneration) {
      throw new Error(`${action} is unavailable because the Codex connection changed`);
    }
    if (this.#subscriptions.get(threadId) !== this.#connectionGeneration) {
      throw new Error(`${action} is unavailable because the thread is not subscribed on the current connection`);
    }
    if (action === "prompt" && this.#directInput.get(threadId) !== true) {
      throw new Error("prompt is unavailable because the thread cannot accept direct input");
    }
    return this.#connectionGeneration;
  }

  #actionOptions(generation, signal) {
    const options = {
      ...(this.#mode === "control" ? { expectedGeneration: generation } : {}),
      ...(signal ? { signal } : {}),
    };
    return Object.keys(options).length ? options : undefined;
  }

  markStale(agent) {
    return {
      ...agent,
      status: "unknown",
      capabilities: noCapabilities(),
      activeTurnId: undefined,
      pendingApprovals: [],
      discovery: {
        ...agent.discovery,
        confidence: "low",
        visibility: agent.discovery?.visibility === "active" ? "recent" : agent.discovery?.visibility,
      },
    };
  }

  isDiscoveryCurrent(agents) {
    if (this.#mode !== "control") return true;
    return this.#started && agents.every(
      (agent) => agent.metadata?.transportGeneration === this.#connectionGeneration,
    );
  }

  #emitChange(event = { type: "changed" }) {
    for (const handler of this.#changeHandlers) {
      try { handler(event); }
      catch {}
    }
  }
}

function codexTimestamp(value) {
  if (!Number.isFinite(value)) return undefined;
  return new Date(value * 1_000).toISOString();
}

function loadedThreadId(thread) {
  return typeof thread === "string" ? thread : thread?.id ?? thread?.threadId;
}
