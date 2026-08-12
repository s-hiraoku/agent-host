#!/usr/bin/env node
import { AgentRegistry } from "./core/registry.js";
import { createRuntimeAdapters } from "./runtime.js";
import { createAgentServer } from "./http/server.js";
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const [command = "serve", ...args] = process.argv.slice(2);
const demoMode = command === "demo" || process.env.AGENT_HOST_DEMO === "1";
const makeRegistry = () => new AgentRegistry(
  createRuntimeAdapters({
    demoMode,
    codexTransport: process.env.AGENT_HOST_CODEX_TRANSPORT,
    codexSocket: process.env.AGENT_HOST_CODEX_SOCKET,
  }),
  { adapterTimeoutMs: Number(process.env.AGENT_HOST_ADAPTER_TIMEOUT_MS ?? "20000") },
);
const host = process.env.AGENT_HOST_BIND ?? "127.0.0.1";
const port = Number(process.env.AGENT_HOST_PORT ?? "4777");

async function writeGeneratedToken(path, token) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("token directory must be a real directory");
  if (process.getuid && directoryStat.uid !== process.getuid()) throw new Error("token directory must be owned by the current user");
  await chmod(directory, 0o700);
  const temporary = join(directory, `.token.${process.pid}.${randomUUID()}`);
  try {
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

if (command === "serve" || command === "demo") {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("AGENT_HOST_BIND must be a loopback host");
  }
  const registry = makeRegistry();
  const server = createAgentServer(registry, {
    host,
    port,
    refreshMs: Number(process.env.AGENT_HOST_REFRESH_MS ?? "1500"),
    apiToken: process.env.AGENT_HOST_API_TOKEN,
    allowedOrigins: String(process.env.AGENT_HOST_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  });
  const tokenPath = process.env.AGENT_HOST_TOKEN_FILE ?? join(homedir(), ".agent-host", "token");
  await server.start();
  try {
    if (server.generatedToken) await writeGeneratedToken(tokenPath, server.apiToken);
  } catch (error) {
    await server.stop();
    throw error;
  }
  const displayHost = host.includes(":") ? `[${host}]` : host;
  console.log(`[agent-host] listening on http://${displayHost}:${port}`);
  if (demoMode) console.log("[agent-host] deterministic demo mode enabled; live adapters are disabled");
  if (server.generatedToken) console.log(`[agent-host] generated API token written to ${tokenPath}`);
  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "list") {
  const registry = makeRegistry();
  await registry.refresh();
  console.log(JSON.stringify({ agents: (await registry.listView("recent")).agents }, null, 2));
  await registry.close();
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
  await registry.close();
  if (!result.ok) process.exitCode = 1;
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
