import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";
import { basename } from "node:path";
import { noCapabilities } from "../core/types.js";

const execFileAsync = promisify(execFile);
const KNOWN = [
  [/(^|\s|\/)(claude)(\s|$)/i, "claude"],
  [/(^|\s|\/)(codex)(\s|$)/i, "codex"],
  [/(^|\s|\/)(gemini)(\s|$)/i, "gemini"],
  [/(^|\s|\/)(opencode)(\s|$)/i, "opencode"],
  [/(^|\s|\/)(hermes)(\s|$)/i, "hermes"],
  [/(^|\s|\/)(cursor-agent)(\s|$)/i, "cursor"],
];
const PROVIDERS = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["gemini", "gemini"],
  ["opencode", "opencode"],
  ["hermes", "hermes"],
  ["cursor-agent", "cursor"],
]);
const SCRIPT_RUNNERS = new Set(["node", "bun", "deno"]);

export function classifyProcessCommand(command) {
  if (/agent-host|codex\s+app-server\b/i.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  while (tokens[0]?.includes("=") && !tokens[0].includes("/")) tokens.shift();
  if (basename(tokens[0] ?? "") === "env") tokens.shift();
  while (tokens[0]?.includes("=") && !tokens[0].includes("/")) tokens.shift();
  const executable = basename(tokens[0] ?? "").toLowerCase();
  const script = SCRIPT_RUNNERS.has(executable) ? basename(tokens[1] ?? "").toLowerCase() : undefined;
  const provider = PROVIDERS.get(executable) ?? PROVIDERS.get(script);
  if (provider) return { provider, confidence: "high" };
  const loose = KNOWN.find(([pattern]) => pattern.test(command));
  return loose ? { provider: loose[1], confidence: "low" } : undefined;
}

async function cwdFor(pid, signal) {
  if (process.platform === "linux") {
    try { return await readlink(`/proc/${pid}/cwd`); }
    catch (error) {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { signal });
      return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    } catch (error) {
      signal?.throwIfAborted();
      return undefined;
    }
  }
}

export class ProcessAdapter {
  id = "process";
  #rawOnlyProviders;
  #execFile;
  #cwdFor;

  constructor(options = {}) {
    this.#rawOnlyProviders = new Set(options.rawOnlyProviders ?? []);
    this.#execFile = options.execFile ?? execFileAsync;
    this.#cwdFor = options.cwdFor ?? cwdFor;
  }

  async discover(options = {}) {
    const { stdout } = await this.#execFile("ps", ["-axo", "pid=,ppid=,tty=,command="], {
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
    });
    const rows = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const agents = [];
    const now = new Date().toISOString();

    for (const row of rows) {
      const match = row.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const tty = match[3] === "?" || match[3] === "??" ? undefined : match[3];
      const command = match[4];
      const classification = classifyProcessCommand(command);
      if (!classification || pid === process.pid) continue;
      const { provider, confidence } = classification;
      options.signal?.throwIfAborted();
      const cwd = await this.#cwdFor(pid, options.signal);
      options.signal?.throwIfAborted();
      agents.push({
        id: `process:${provider}:${pid}`,
        provider,
        source: this.id,
        name: `${provider}${cwd ? ` · ${cwd.split("/").filter(Boolean).at(-1)}` : ` · ${pid}`}`,
        status: "unknown",
        capabilities: noCapabilities(),
        pid,
        cwd,
        tty,
        discovery: {
          kind: "process",
          confidence,
          visibility: confidence === "high" && !this.#rawOnlyProviders.has(provider) ? "active" : "raw",
        },
        metadata: { command, ppid: Number(match[2]) },
        discoveredAt: now,
        updatedAt: now,
      });
    }
    return agents;
  }

  async interrupt(agent) {
    if (!agent.pid) return { ok: false, agentId: agent.id, action: "interrupt", message: "missing pid" };
    try {
      process.kill(agent.pid, "SIGINT");
      return { ok: true, agentId: agent.id, action: "interrupt" };
    } catch (error) {
      return { ok: false, agentId: agent.id, action: "interrupt", message: String(error) };
    }
  }
}
