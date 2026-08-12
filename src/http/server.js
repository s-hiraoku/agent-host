import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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
import { ActionExecutor } from "./action-executor.js";
import { SseClient } from "./sse-client.js";

const MAX_BODY_BYTES = 1_000_000;

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

export function createAgentServer(registry, options) {
  const eventClients = new Set();
  const clientDepths = new Map();
  const operations = options.operations;
  const security = createApiSecurity(options);
  const actionExecutor = new ActionExecutor(registry, options);
  let stopping = false;
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
      operations?.logger.log(ok ? "info" : "warn", "action.completed", {
        component: "http",
        requestId: audit.requestId,
        actionKind: audit.action,
        outcome: ok ? "success" : "failure",
        code,
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
        operations?.logger.log("debug", "action.attempted", {
          component: "http", requestId: audit.requestId, actionKind: audit.action,
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
      if (req.method === "GET" && url.pathname === "/v1/diagnostics") {
        return send(res, 200, {
          apiVersion: API_VERSION,
          diagnostics: operations?.snapshot({
            configuration: options.diagnosticsConfiguration,
            readiness: registry.readiness(),
          }) ?? {
            generatedAt: new Date().toISOString(),
            readiness: registry.readiness(),
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/agents") {
        const snapshot = await registry.listView(url.searchParams.get("view") ?? "recent");
        const query = parseAgentListQuery(url.searchParams, snapshot.cursorRevision);
        return send(res, 200, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          ...pageAgents(snapshot.agents, query, snapshot.cursorRevision),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/refresh") {
        if (stopping) throw new ContractError("shutting_down", "agent-host is shutting down", 503);
        const agents = await registry.refresh({ force: true });
        return send(res, 200, {
          apiVersion: API_VERSION,
          revision: registry.revision,
          agentCount: agents.length,
          ...registry.readiness(),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let unsubscribe = () => {};
        let heartbeat;
        let client;
        const updateDepth = (depth) => {
          clientDepths.set(client, depth);
          operations?.metrics.setGauge("sse_queue_depth", [...clientDepths.values()].reduce((sum, value) => sum + value, 0));
        };
        const closeClient = () => {
          clearInterval(heartbeat);
          eventClients.delete(client);
          clientDepths.delete(client);
          unsubscribe();
          operations?.metrics.setGauge("event_subscribers", eventClients.size);
          operations?.metrics.setGauge("sse_queue_depth", [...clientDepths.values()].reduce((sum, value) => sum + value, 0));
        };
        client = new SseClient(res, { operations, onDepth: updateDepth, onClose: closeClient });
        eventClients.add(client);
        clientDepths.set(client, 0);
        operations?.metrics.increment("sse_connections");
        if (req.headers["last-event-id"]) operations?.metrics.increment("sse_reconnects", { transport: "dashboard_sse" });
        operations?.metrics.setGauge("event_subscribers", eventClients.size);
        unsubscribe = registry.events.subscribe((event) => client.send(formatSse(event.type, {
          apiVersion: API_VERSION,
          ...eventView(event),
        })));
        client.send(formatSse("ready", {
          ok: true,
          apiVersion: API_VERSION,
          revision: registry.revision,
          sequence: registry.events.sequence,
          initialLoading: registry.initialLoading,
        }));
        heartbeat = setInterval(() => client.send(": keepalive\n\n", { heartbeat: true }), 15_000);
        heartbeat.unref();
        req.on("close", () => client.close());
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
        if (stopping) throw new ContractError("shutting_down", "agent-host is shutting down", 503);
        security.requireJson(req);
        const agentId = audit.agentId;
        const payload = await jsonBody(req);
        const { result, replayed } = await actionExecutor.execute(
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
      if (error?.code === "queue_full") res.setHeader("retry-after", "1");
      sendError(
        res,
        error instanceof ContractError ? error.status : 500,
        error instanceof ContractError ? error.code : "internal_error",
        error instanceof ContractError ? error.message : "internal server error",
      );
    }
  });

  let timer;
  let started = false;
  return {
    get apiToken() { return security.apiToken; },
    get generatedToken() { return security.generatedToken; },
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, resolve);
      });
      started = true;
      operations?.logger.log("info", "server.started", { component: "http", outcome: "success" });
      void registry.refresh({ force: false });
      timer = setInterval(() => void registry.refresh({ force: false }), options.refreshMs);
      timer.unref();
      return server.address();
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (timer) clearInterval(timer);
      for (const client of [...eventClients]) client.close();
      const closed = started
        ? new Promise((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      const actionState = await actionExecutor.shutdown({ graceMs: options.shutdownGraceMs });
      try {
        await registry.close?.();
        if (actionState.timedOut) server.closeAllConnections?.();
        let shutdownTimer;
        await Promise.race([
          closed,
          new Promise((resolve) => { shutdownTimer = setTimeout(resolve, options.shutdownGraceMs ?? 5_000); }),
        ]);
        clearTimeout(shutdownTimer);
      } finally {
        eventClients.clear();
        clientDepths.clear();
        operations?.logger.log("info", "server.stopped", { component: "http", outcome: "success" });
        operations?.close?.();
      }
    },
  };
}

function formatSse(type, body) {
  return `id: ${body.sequence}\nevent: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
}
