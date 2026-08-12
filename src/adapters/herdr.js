import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATES = new Set(["idle", "working", "blocked", "done"]);
const mapStatus = (value) => STATES.has(value) ? value : "unknown";

async function run(args, options = {}) {
  const { stdout } = await execFileAsync("herdr", args, { maxBuffer: 10 * 1024 * 1024, signal: options.signal });
  return JSON.parse(stdout);
}

export class HerdrAdapter {
  id = "herdr";

  async discover(options = {}) {
    try {
      const payload = await run(["api", "snapshot"], options);
      const result = payload.result ?? payload;
      const rawAgents = result.agents ?? result.snapshot?.agents ?? [];
      const now = new Date().toISOString();
      return rawAgents.map((item) => {
        const target = String(item.name ?? item.pane_id ?? item.agent ?? "unknown");
        const provider = String(item.agent ?? "herdr-agent");
        const paneId = item.pane_id ? String(item.pane_id) : undefined;
        const pid = Number(item.foreground_pid ?? item.pid) || undefined;
        const status = mapStatus(item.agent_status ?? item.status);
        return {
          id: `herdr:${paneId ?? target}`,
          provider,
          source: this.id,
          name: String(item.name ?? `${provider} · ${paneId ?? target}`),
          status,
          capabilities: { prompt: true, sendKeys: true, approve: false, reject: false, interrupt: true, focus: true, read: true },
          cwd: item.foreground_cwd ?? item.cwd,
          sessionId: item.agent_session?.value,
          target,
          pid,
          lastActivityAt: item.last_activity_at ?? item.updated_at,
          discovery: {
            kind: "native",
            confidence: "high",
            visibility: status === "working" || status === "blocked" ? "active" : "recent",
          },
          metadata: { paneId, herdr: item },
          discoveredAt: now,
          updatedAt: now,
        };
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      if (String(error?.stderr ?? error).toLowerCase().includes("socket")) return [];
      throw error;
    }
  }

  async prompt(agent, text, options = {}) { return this.#runAction(agent, "prompt", ["agent", "prompt", agent.target, text], options); }
  async sendKeys(agent, keys, options = {}) { return this.#runAction(agent, "send-keys", ["agent", "send-keys", agent.target, ...keys], options); }
  async interrupt(agent, options = {}) { return this.sendKeys(agent, ["ctrl+c"], options); }
  async focus(agent, options = {}) { return this.#runAction(agent, "focus", ["agent", "focus", agent.target], options); }
  async read(agent, options = {}) { return this.#runAction(agent, "read", ["agent", "read", agent.target, "--source", "recent-unwrapped", "--lines", "120"], options); }

  async #runAction(agent, action, args, options) {
    try { return { ok: true, agentId: agent.id, action, data: await run(args, options) }; }
    catch (error) { return { ok: false, agentId: agent.id, action, message: String(error) }; }
  }
}
