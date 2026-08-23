import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";
import { basename } from "node:path";
import { noCapabilities } from "../core/types.js";
import { createMacAppFocus, MAC_DESKTOP_APPS } from "./mac-app-focus.js";

const execFileAsync = promisify(execFile);
const DESKTOP_GUI_MAINS = [
  { provider: "claude", app: MAC_DESKTOP_APPS.claude },
  { provider: "codex", app: MAC_DESKTOP_APPS.chatgpt },
];
const DESKTOP_FOCUS_APPS = new Map(DESKTOP_GUI_MAINS.map(({ app }) => [app.appName, app]));
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

function processDisplayName(provider, pid, cwd, desktopApp) {
  if (desktopApp?.appName) return `${desktopApp.appName}.app`;
  const leaf = typeof cwd === "string" && cwd.length > 0 ? basename(cwd) : "";
  return `${provider} · ${leaf || String(pid)}`;
}

export function classifyDesktopGuiCommand(command) {
  if (typeof command !== "string") return undefined;
  for (const { provider, app } of DESKTOP_GUI_MAINS) {
    const escaped = app.appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`/${escaped}\\.app/Contents/MacOS/${escaped}(?:\\s|$)`);
    if (pattern.test(command)) {
      return { provider, confidence: "high", desktopApp: { appName: app.appName } };
    }
  }
}

export function classifyProcessCommand(command) {
  if (/agent-host/i.test(command)) return undefined;
  const desktop = classifyDesktopGuiCommand(command);
  if (desktop) return desktop;
  if (command.includes(".app/Contents/") || /codex\s+app-server\b/i.test(command)) return undefined;
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
  #appFocus;

  constructor(options = {}) {
    this.#rawOnlyProviders = new Set(options.rawOnlyProviders ?? []);
    this.#execFile = options.execFile ?? execFileAsync;
    this.#cwdFor = options.cwdFor ?? cwdFor;
    this.#appFocus = options.appFocus ?? createMacAppFocus(options.appFocusOptions);
  }

  async discover(options = {}) {
    const { stdout } = await this.#execFile("ps", ["-axo", "pid=,ppid=,tty=,command="], {
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
    });
    const rows = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const agents = [];
    const now = new Date().toISOString();
    const focusAvailable = new Map();

    for (const row of rows) {
      const match = row.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const tty = match[3] === "?" || match[3] === "??" ? undefined : match[3];
      const command = match[4];
      const classification = classifyProcessCommand(command);
      if (!classification || pid === process.pid) continue;
      const { provider, confidence, desktopApp } = classification;
      options.signal?.throwIfAborted();
      const cwd = await this.#cwdFor(pid, options.signal);
      options.signal?.throwIfAborted();
      const capabilities = noCapabilities();
      if (desktopApp) {
        if (!focusAvailable.has(desktopApp.appName)) {
          focusAvailable.set(desktopApp.appName, await this.#appFocus.available(desktopApp));
        }
        capabilities.focus = focusAvailable.get(desktopApp.appName) === true;
      }
      agents.push({
        id: `process:${provider}:${pid}`,
        provider,
        source: this.id,
        name: processDisplayName(provider, pid, cwd, desktopApp),
        status: "unknown",
        capabilities,
        pid,
        cwd,
        tty,
        discovery: {
          kind: "process",
          confidence,
          visibility: confidence === "high" && (desktopApp || !this.#rawOnlyProviders.has(provider))
            ? "active"
            : "raw",
        },
        metadata: { command, ppid: Number(match[2]), desktopApp },
        discoveredAt: now,
        updatedAt: now,
      });
    }
    return agents;
  }

  async focus(agent) {
    const app = DESKTOP_FOCUS_APPS.get(agent?.metadata?.desktopApp?.appName);
    if (!app || !await this.#appFocus.available(app)) {
      return {
        ok: false,
        code: "capability_not_available",
        agentId: agent?.id,
        action: "focus",
        message: "capability focus is not available",
      };
    }
    const result = await this.#appFocus.activate(app);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code ?? "desktop_focus_failed",
        agentId: agent.id,
        action: "focus",
        message: "Desktop application could not be brought to the front",
      };
    }
    return { ok: true, agentId: agent.id, action: "focus" };
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
