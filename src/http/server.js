import { createServer } from "node:http";
import {
  API_VERSION,
  ContractError,
  actionResult,
  agentDetail,
  pageAgents,
  parseAgentListQuery,
} from "../core/contracts.js";

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ContractError("invalid_json", "request body must be valid JSON"); }
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
  const eventResponses = new Set();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, apiVersion: API_VERSION, revision: registry.revision });
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
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        eventResponses.add(res);
        const unsubscribe = registry.events.subscribe((event) => res.write(
          `event: ${event.type}\ndata: ${JSON.stringify({ apiVersion: API_VERSION, ...event })}\n\n`,
        ));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: ready\ndata: ${JSON.stringify({
          ok: true,
          apiVersion: API_VERSION,
          revision: registry.revision,
          sequence: registry.events.sequence,
        })}\n\n`);
        req.on("close", () => {
          eventResponses.delete(res);
          unsubscribe();
        });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (req.method === "GET" && agentMatch) {
        const agent = registry.get(decodeURIComponent(agentMatch[1]));
        return agent
          ? send(res, 200, { apiVersion: API_VERSION, revision: registry.revision, agent: agentDetail(agent) })
          : sendError(res, 404, "agent_not_found", "agent not found");
      }
      const actionMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(prompt|send-keys|approve|reject|interrupt|focus|read)$/);
      if (req.method === "POST" && actionMatch) {
        const result = await registry.action(decodeURIComponent(actionMatch[1]), actionMatch[2], await jsonBody(req));
        return result.ok
          ? send(res, 200, {
              apiVersion: API_VERSION,
              result: actionResult(result, decodeURIComponent(actionMatch[1]), actionMatch[2]),
            })
          : sendError(res, actionErrorStatus(result.code), result.code, result.message, {
              agentId: result.agentId,
              action: result.action,
            });
      }
      sendError(res, 404, "not_found", "route not found");
    } catch (error) {
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
    async start() {
      await registry.refresh();
      timer = setInterval(() => void registry.refresh(), options.refreshMs);
      timer.unref();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, resolve);
      });
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
