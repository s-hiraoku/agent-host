import test from "node:test";
import assert from "node:assert/strict";
import { classifyProcessCommand } from "../src/adapters/process.js";

test("process classification distinguishes direct agents from helpers and loose matches", () => {
  assert.deepEqual(classifyProcessCommand("/opt/homebrew/bin/codex"), { provider: "codex", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("node /opt/tools/claude"), { provider: "claude", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("zsh -c codex"), { provider: "codex", confidence: "low" });
  assert.deepEqual(classifyProcessCommand("rg codex src"), { provider: "codex", confidence: "low" });
  assert.equal(classifyProcessCommand("codex app-server --listen stdio://"), undefined);
  assert.equal(classifyProcessCommand("node src/cli.js agent-host"), undefined);
});
