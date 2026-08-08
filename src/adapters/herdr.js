import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATES = new Set(["idle", "working", "blocked", "done"]);
const mapStatus = (value) => STATES.has(value) ? value : "unknown";

async function run(args) {
  const { stdout } = await execFileAsync("herdr", args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export class HerdrAdapter {
  id = "herdr";

  async discover() {
    try {
      const payload = await run(["api", "snapshot"]);
      const result = payload.result ?? payload;
      const rawAgents = result.agents ?? result.snapshot?.agents ?? [];
      const now = new Date().toISOString();
      return rawAgents.map((item) => {
        const target = String(item.name ?? item.pane_id ?? item.agent ?? "unknown");
        const provider = String(item.agent ?? "herdr-agent");
        const paneId = item.pane_id ? String(item.pane_id) : undefined;
        return {
          id: `herdr:${paneId ?? target}`,
          provider,
          source: this.id,
          name: String(item.name ?? `${provider} · ${paneId ?? target}`),
          status: mapStatus(item.agent_status ?? item.status),
          capabilities: { prompt: true, sendKeys: true, approve: false, reject: false, interrupt: true, focus: true, read: true },
          cwd: item.foreground_cwd ?? item.cwd,
          sessionId: item.agent_session?.value,
          target,
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

  async prompt(agent, text) { return this.#runAction(agent, "prompt", ["agent", "prompt", agent.target, text]); }
  async sendKeys(agent, keys) { return this.#runAction(agent, "send-keys", ["agent", "send-keys", agent.target, ...keys]); }
  async interrupt(agent) { return this.sendKeys(agent, ["ctrl+c"]); }
  async focus(agent) { return this.#runAction(agent, "focus", ["agent", "focus", agent.target]); }
  async read(agent) { return this.#runAction(agent, "read", ["agent", "read", agent.target, "--source", "recent-unwrapped", "--lines", "120"]); }

  async #runAction(agent, action, args) {
    try { return { ok: true, agentId: agent.id, action, data: await run(args) }; }
    catch (error) { return { ok: false, agentId: agent.id, action, message: String(error) }; }
  }
}
