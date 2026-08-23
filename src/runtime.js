import { CodexAdapter } from "./adapters/codex.js";
import { CursorDesktopAdapter } from "./adapters/cursor-desktop.js";
import { CursorSdkBridgeRuntimeAdapter } from "./adapters/cursor-sdk-runtime.js";
import { DemoAdapter, DemoLaunchAdapter } from "./adapters/demo.js";
import { HerdrAdapter } from "./adapters/herdr.js";
import { ProcessAdapter } from "./adapters/process.js";
import { isAbsolute } from "node:path";

export function createRuntimeAdapters({
  demoMode = false,
  codexTransport = "owned",
  codexSocket,
  cursorUserDataDirectory,
  cursorProjectsDirectory,
  cursorSdkBridge,
  enabledAdapters = ["codex", "herdr", "process"],
} = {}) {
  if (demoMode) return [new DemoAdapter(), new DemoLaunchAdapter()];
  if (codexTransport !== "owned" && codexTransport !== "control") {
    throw new Error("AGENT_HOST_CODEX_TRANSPORT must be owned or control");
  }
  if (enabledAdapters.includes("codex") && codexTransport === "control" && (!codexSocket || !isAbsolute(codexSocket))) {
    throw new Error("AGENT_HOST_CODEX_SOCKET must be an absolute path in control mode");
  }
  const factories = new Map([
    ["codex", () => codexTransport === "control"
      ? new CodexAdapter({ mode: "control", rpc: { transport: "control", socketPath: codexSocket } })
      : new CodexAdapter()],
    ["herdr", () => new HerdrAdapter()],
    ["process", () => new ProcessAdapter({ rawOnlyProviders: codexTransport === "control" ? ["codex"] : [] })],
    ["cursor-desktop", () => new CursorDesktopAdapter({
      userDataDirectory: cursorUserDataDirectory,
      projectsDirectory: cursorProjectsDirectory,
    })],
    ["cursor-sdk-bridge", () => new CursorSdkBridgeRuntimeAdapter(cursorSdkBridge)],
  ]);
  return enabledAdapters.map((name) => factories.get(name)?.()).filter(Boolean);
}
