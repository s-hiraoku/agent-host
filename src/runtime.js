import { CodexAdapter } from "./adapters/codex.js";
import { DemoAdapter } from "./adapters/demo.js";
import { HerdrAdapter } from "./adapters/herdr.js";
import { ProcessAdapter } from "./adapters/process.js";
import { isAbsolute } from "node:path";

export function createRuntimeAdapters({ demoMode = false, codexTransport = "owned", codexSocket } = {}) {
  if (demoMode) return [new DemoAdapter()];
  if (codexTransport !== "owned" && codexTransport !== "control") {
    throw new Error("AGENT_HOST_CODEX_TRANSPORT must be owned or control");
  }
  if (codexTransport === "control" && (!codexSocket || !isAbsolute(codexSocket))) {
    throw new Error("AGENT_HOST_CODEX_SOCKET must be an absolute path in control mode");
  }
  const codex = codexTransport === "control"
    ? new CodexAdapter({
      mode: "control",
      rpc: { transport: "control", socketPath: codexSocket },
    })
    : new CodexAdapter();
  return [
    codex,
    new HerdrAdapter(),
    new ProcessAdapter({ rawOnlyProviders: codexTransport === "control" ? ["codex"] : [] }),
  ];
}
