import { CodexAdapter } from "./adapters/codex.js";
import { DemoAdapter } from "./adapters/demo.js";
import { HerdrAdapter } from "./adapters/herdr.js";
import { ProcessAdapter } from "./adapters/process.js";

export function createRuntimeAdapters({ demoMode = false } = {}) {
  return demoMode
    ? [new DemoAdapter()]
    : [new CodexAdapter(), new HerdrAdapter(), new ProcessAdapter()];
}
