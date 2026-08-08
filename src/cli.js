#!/usr/bin/env node
import { AgentRegistry } from "./core/registry.js";
import { ProcessAdapter } from "./adapters/process.js";
import { HerdrAdapter } from "./adapters/herdr.js";
import { createAgentServer } from "./http/server.js";

const makeRegistry = () => new AgentRegistry([new HerdrAdapter(), new ProcessAdapter()]);
const [command = "serve", ...args] = process.argv.slice(2);
const host = process.env.AGENT_HOST_BIND ?? "127.0.0.1";
const port = Number(process.env.AGENT_HOST_PORT ?? "4777");

if (command === "serve") {
  const registry = makeRegistry();
  const server = createAgentServer(registry, { host, port, refreshMs: Number(process.env.AGENT_HOST_REFRESH_MS ?? "1500") });
  await server.start();
  console.log(`[agent-host] listening on http://${host}:${port}`);
  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "list") {
  const registry = makeRegistry();
  console.log(JSON.stringify({ agents: await registry.refresh() }, null, 2));
} else if (command === "action") {
  const [id, action, ...rest] = args;
  if (!id || !action) {
    console.error("usage: agent-host action <agent-id> <action> [payload-json]");
    process.exit(2);
  }
  const registry = makeRegistry();
  await registry.refresh();
  const payload = rest.length ? JSON.parse(rest.join(" ")) : undefined;
  const result = await registry.action(id, action, payload);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
