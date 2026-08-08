import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";
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

async function cwdFor(pid) {
  if (process.platform === "linux") {
    try { return await readlink(`/proc/${pid}/cwd`); } catch { return undefined; }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    } catch { return undefined; }
  }
}

export class ProcessAdapter {
  id = "process";

  async discover() {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,tty=,command="], { maxBuffer: 10 * 1024 * 1024 });
    const rows = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const agents = [];
    const now = new Date().toISOString();

    for (const row of rows) {
      const match = row.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const tty = match[3] === "?" || match[3] === "??" ? undefined : match[3];
      const command = match[4];
      const known = KNOWN.find(([pattern]) => pattern.test(command));
      if (!known || pid === process.pid || command.includes("agent-host") || command.includes("codex app-server --listen stdio://")) continue;
      const provider = known[1];
      const cwd = await cwdFor(pid);
      agents.push({
        id: `process:${provider}:${pid}`,
        provider,
        source: this.id,
        name: `${provider}${cwd ? ` · ${cwd.split("/").filter(Boolean).at(-1)}` : ` · ${pid}`}`,
        status: "unknown",
        capabilities: { ...noCapabilities(), interrupt: true },
        pid,
        cwd,
        tty,
        metadata: { command },
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
