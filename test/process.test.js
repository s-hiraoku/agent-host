import test from "node:test";
import assert from "node:assert/strict";
import { classifyProcessCommand, ProcessAdapter } from "../src/adapters/process.js";

test("process classification distinguishes direct agents from helpers and loose matches", () => {
  assert.deepEqual(classifyProcessCommand("/opt/homebrew/bin/codex"), { provider: "codex", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("node /opt/tools/claude"), { provider: "claude", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("NODE_ENV=production /usr/bin/codex"), { provider: "codex", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("env FOO=1 codex"), { provider: "codex", confidence: "high" });
  assert.deepEqual(classifyProcessCommand("zsh -c codex"), { provider: "codex", confidence: "low" });
  assert.deepEqual(classifyProcessCommand("rg codex src"), { provider: "codex", confidence: "low" });
  assert.equal(classifyProcessCommand("codex app-server --listen stdio://"), undefined);
  assert.equal(classifyProcessCommand("node src/cli.js agent-host"), undefined);
});

test("process adapter can keep supported control-provider processes raw-only", async () => {
  const execFile = async () => ({
    stdout: "100 1 ttys001 /opt/homebrew/bin/codex\n101 1 ttys002 /opt/homebrew/bin/claude\n",
  });
  const cwdFor = async (pid) => `/tmp/project-${pid}`;
  const adapter = new ProcessAdapter({ rawOnlyProviders: ["codex"], execFile, cwdFor });
  const agents = await adapter.discover();
  assert.equal(agents.find((agent) => agent.provider === "codex").discovery.visibility, "raw");
  assert.equal(agents.find((agent) => agent.provider === "claude").discovery.visibility, "active");
});

test("process adapter names use a path leaf or pid, never undefined", async () => {
  const execFile = async () => ({
    stdout: [
      "100 1 ttys001 /opt/homebrew/bin/claude",
      "101 1 ttys002 /opt/homebrew/bin/claude",
      "102 1 ttys003 /opt/homebrew/bin/claude",
      "103 1 ttys004 /opt/homebrew/bin/claude",
      "104 1 ttys005 /opt/homebrew/bin/claude",
    ].join("\n"),
  });
  const cwds = {
    100: "/Users/me/agent-host",
    101: "/",
    102: undefined,
    103: "",
    104: "/Users/me/agent-host/",
  };
  const adapter = new ProcessAdapter({
    execFile,
    cwdFor: async (pid) => cwds[pid],
  });
  const names = Object.fromEntries((await adapter.discover()).map((agent) => [agent.pid, agent.name]));
  assert.equal(names[100], "claude · agent-host");
  assert.equal(names[101], "claude · 101");
  assert.equal(names[102], "claude · 102");
  assert.equal(names[103], "claude · 103");
  assert.equal(names[104], "claude · agent-host");
  assert.equal(Object.values(names).some((name) => name.includes("undefined")), false);
});
