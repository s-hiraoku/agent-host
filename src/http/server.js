import { createServer } from "node:http";

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createAgentServer(registry, options) {
  const eventResponses = new Set();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/agents") return send(res, 200, { agents: registry.list() });
      if (req.method === "POST" && url.pathname === "/v1/refresh") return send(res, 200, { agents: await registry.refresh() });
      if (req.method === "GET" && url.pathname === "/v1/events") {
        eventResponses.add(res);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        const unsubscribe = registry.events.subscribe((event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        req.on("close", () => {
          eventResponses.delete(res);
          unsubscribe();
        });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (req.method === "GET" && agentMatch) {
        const agent = registry.get(decodeURIComponent(agentMatch[1]));
        return agent ? send(res, 200, agent) : send(res, 404, { error: "agent not found" });
      }
      const actionMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(prompt|send-keys|approve|reject|interrupt|focus|read)$/);
      if (req.method === "POST" && actionMatch) {
        const result = await registry.action(decodeURIComponent(actionMatch[1]), actionMatch[2], await jsonBody(req));
        return send(res, result.ok ? 200 : 409, result);
      }
      send(res, 404, { error: "not found" });
    } catch (error) { send(res, 500, { error: String(error) }); }
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
