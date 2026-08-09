import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  API_VERSION,
  ContractError,
  actionResult,
  agentDetail,
  eventView,
  pageAgents,
  parseAgentListQuery,
} from "../core/contracts.js";
import { createApiSecurity } from "./security.js";

const MAX_BODY_BYTES = 1_000_000;
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const MAX_IDEMPOTENCY_ENTRIES = 1_000;

async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ContractError("payload_too_large", "request body is too large", 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ContractError("invalid_json", "request body must be valid JSON"); }
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); }
  catch { throw new ContractError("invalid_agent_id", "agent id is not valid percent-encoded text"); }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  send(res, status, { apiVersion: API_VERSION, error });
}

function actionErrorStatus(code) {
  switch (code) {
    case "agent_not_found": return 404;
    case "unknown_action": return 400;
    case "adapter_not_found": return 500;
    default: return 409;
  }
}

function createActionExecutor(registry, options = {}) {
  const cache = new Map();
  const queues = new Map();
  const ttlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  return async (agentId, action, payload, key) => {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key ?? "")) {
      throw new ContractError("invalid_idempotency_key", "Idempotency-Key must be 8-128 safe ASCII characters");
    }
    const now = Date.now();
    for (const [cachedKey, entry] of cache) {
      if (entry.settled && entry.expiresAt <= now) cache.delete(cachedKey);
    }
    const signature = createHash("sha256").update(JSON.stringify({ agentId, action, payload })).digest("base64url");
    const existing = cache.get(key);
    if (existing) {
      if (existing.signature !== signature) {
        throw new ContractError("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { result: await existing.promise, replayed: true };
    }
    if (cache.size >= MAX_IDEMPOTENCY_ENTRIES) {
      throw new ContractError("idempotency_cache_full", "too many idempotent actions are in progress", 503);
    }

    const previous = queues.get(agentId) ?? Promise.resolve();
    const entry = { signature, settled: false, expiresAt: Infinity };
    entry.promise = previous.catch(() => {}).then(() => registry.action(agentId, action, payload));
    const tail = entry.promise.catch(() => {}).finally(() => {
      entry.settled = true;
      entry.expiresAt = Date.now() + ttlMs;
      if (queues.get(agentId) === tail) queues.delete(agentId);
    });
    queues.set(agentId, tail);
    cache.set(key, entry);
    return { result: await entry.promise, replayed: false };
  };
}

export function createAgentServer(registry, options) {
  const eventResponses = new Set();
  const security = createApiSecurity(options);
  const executeAction = createActionExecutor(registry, options);
  const server = createServer(async (req, res) => {
    let audit;
    let auditCompleted = false;
    const completeAudit = (ok, code, replayed = false) => {
      if (!audit || auditCompleted) return;
      auditCompleted = true;
      registry.events.emit({
        type: "audit.action",
        phase: "completed",
        requestId: audit.requestId,
        agentId: audit.agentId,
        action: audit.action,
        ok,
        code,
        replayed,
        snapshotRevision: registry.revision,
        at: new Date().toISOString(),
      });
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const actionMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(prompt|send-keys|approve|reject|interrupt|focus|read)$/);
      const requestOrigin = security.validateHost(req, server.address());
      const origin = security.validateOrigin(req, requestOrigin);
      security.applyCors(res, origin);
      if (req.method === "OPTIONS") return security.preflight(req, res, origin);
      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) security.authenticate(req, res);

      if (req.method === "POST" && actionMatch) {
        audit = {
          requestId: randomUUID(),
          agentId: decodeSegment(actionMatch[1]),
          action: actionMatch[2],
        };
        registry.events.emit({
          type: "audit.action",
          phase: "attempted",
          ...audit,
          snapshotRevision: registry.revision,
          at: new Date().toISOString(),
        });
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, live: true, apiVersion: API_VERSION, revision: registry.revision });
      }
      if (req.method === "GET" && url.pathname === "/ready") {
        const { adapters: _adapters, ...readiness } = registry.readiness();
        return send(res, readiness.ready ? 200 : 503, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          ...readiness,
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/adapters") {
        return send(res, 200, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          ...registry.readiness(),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/agents") {
        const query = parseAgentListQuery(url.searchParams, registry.revision);
        return send(res, 200, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          ...pageAgents(registry.list(), query, registry.revision),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/refresh") {
        const agents = await registry.refresh();
        return send(res, 200, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          agentCount: agents.length,
          ...registry.readiness(),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        eventResponses.add(res);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const unsubscribe = registry.events.subscribe((event) => res.write(
          `event: ${event.type}\ndata: ${JSON.stringify({ apiVersion: API_VERSION, ...eventView(event) })}\n\n`,
        ));
        res.write(`event: ready\ndata: ${JSON.stringify({
          ok: true,
          apiVersion: API_VERSION,
          revision: registry.revision,
          sequence: registry.events.sequence,
          initialLoading: registry.initialLoading,
        })}\n\n`);
        req.on("close", () => {
          eventResponses.delete(res);
          unsubscribe();
        });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (req.method === "GET" && agentMatch) {
        const agent = registry.get(decodeSegment(agentMatch[1]));
        return agent
          ? send(res, 200, { apiVersion: API_VERSION, revision: registry.revision, agent: agentDetail(agent) })
          : sendError(res, 404, "agent_not_found", "agent not found");
      }
      if (req.method === "POST" && actionMatch) {
        security.requireJson(req);
        const agentId = audit.agentId;
        const payload = await jsonBody(req);
        const { result, replayed } = await executeAction(
          agentId,
          actionMatch[2],
          payload,
          req.headers["idempotency-key"],
        );
        completeAudit(result.ok, result.code, replayed);
        return result.ok
          ? send(res, 200, {
              apiVersion: API_VERSION,
              result: { ...actionResult(result, agentId, actionMatch[2]), replayed },
            })
          : sendError(res, actionErrorStatus(result.code), result.code, result.message, {
              agentId: result.agentId,
              action: result.action,
            });
      }
      sendError(res, 404, "not_found", "route not found");
    } catch (error) {
      completeAudit(false, error instanceof ContractError ? error.code : "internal_error");
      if (res.headersSent) return res.end();
      sendError(
        res,
        error instanceof ContractError ? error.status : 500,
        error instanceof ContractError ? error.code : "internal_error",
        error instanceof ContractError ? error.message : "internal server error",
      );
    }
  });

  let timer;
  return {
    get apiToken() { return security.apiToken; },
    get generatedToken() { return security.generatedToken; },
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, resolve);
      });
      void registry.refresh();
      timer = setInterval(() => void registry.refresh(), options.refreshMs);
      timer.unref();
      return server.address();
    },
    async stop() {
      if (timer) clearInterval(timer);
      for (const res of eventResponses) res.end();
      try {
        await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      } finally {
        eventResponses.clear();
        await registry.close?.();
      }
    },
  };
}
