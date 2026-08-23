import test from "node:test";
import assert from "node:assert/strict";
import { classifyDesktopGuiCommand, classifyProcessCommand, ProcessAdapter } from "../src/adapters/process.js";

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

test("process classification recognizes only desktop GUI main binaries", () => {
  assert.deepEqual(
    classifyProcessCommand("/Applications/Claude.app/Contents/MacOS/Claude"),
    { provider: "claude", confidence: "high", desktopApp: { appName: "Claude" } },
  );
  assert.deepEqual(
    classifyProcessCommand("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    { provider: "codex", confidence: "high", desktopApp: { appName: "ChatGPT" } },
  );
  assert.equal(classifyDesktopGuiCommand("/opt/homebrew/bin/claude"), undefined);
  assert.equal(classifyDesktopGuiCommand("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"), undefined);
  assert.equal(classifyDesktopGuiCommand("/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://"), undefined);
  assert.equal(classifyProcessCommand("/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://"), undefined);
  assert.equal(classifyProcessCommand("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"), undefined);
  assert.equal(classifyProcessCommand("/Applications/ChatGPT.app/Contents/Resources/codex sandbox -- /usr/bin/true"), undefined);
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

test("process adapter advertises app-level focus only for desktop GUI mains", async () => {
  const activations = [];
  const adapter = new ProcessAdapter({
    rawOnlyProviders: ["codex"],
    execFile: async () => ({
      stdout: [
        "200 1 ?? /Applications/Claude.app/Contents/MacOS/Claude",
        "201 1 ?? /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        "202 1 ttys001 /opt/homebrew/bin/claude",
        "203 1 ttys002 /opt/homebrew/bin/codex",
        "204 1 ?? /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
        "205 1 ?? /Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://",
      ].join("\n"),
    }),
    cwdFor: async (pid) => `/tmp/project-${pid}`,
    appFocus: {
      available: async (app) => app.appName === "Claude" || app.appName === "ChatGPT",
      activate: async (app) => {
        activations.push(app.appName);
        return { ok: true };
      },
    },
  });
  const agents = Object.fromEntries((await adapter.discover()).map((agent) => [agent.pid, agent]));
  assert.equal(agents[200].name, "Claude.app");
  assert.equal(agents[200].provider, "claude");
  assert.equal(agents[200].capabilities.focus, true);
  assert.equal(agents[200].discovery.visibility, "active");
  assert.equal(agents[201].name, "ChatGPT.app");
  assert.equal(agents[201].provider, "codex");
  assert.equal(agents[201].capabilities.focus, true);
  assert.equal(agents[201].discovery.visibility, "active");
  assert.equal(agents[202].name, "claude · project-202");
  assert.equal(agents[202].capabilities.focus, false);
  assert.equal(agents[203].capabilities.focus, false);
  assert.equal(agents[203].discovery.visibility, "raw");
  assert.equal(agents[204], undefined);
  assert.equal(agents[205], undefined);
  assert.deepEqual(await adapter.focus(agents[200]), { ok: true, agentId: agents[200].id, action: "focus" });
  assert.deepEqual(await adapter.focus(agents[201]), { ok: true, agentId: agents[201].id, action: "focus" });
  assert.deepEqual(activations, ["Claude", "ChatGPT"]);
  assert.deepEqual(await adapter.focus(agents[202]), {
    ok: false,
    code: "capability_not_available",
    agentId: agents[202].id,
    action: "focus",
    message: "capability focus is not available",
  });
});

test("process desktop focus stays off when the application is absent", async () => {
  const adapter = new ProcessAdapter({
    execFile: async () => ({
      stdout: "200 1 ?? /Applications/Claude.app/Contents/MacOS/Claude\n",
    }),
    cwdFor: async () => "/tmp/project",
    appFocus: {
      available: async () => false,
      activate: async () => {
        throw new Error("activate should not run when focus is not advertised");
      },
    },
  });
  const agent = (await adapter.discover())[0];
  assert.equal(agent.capabilities.focus, false);
  assert.deepEqual(await adapter.focus(agent), {
    ok: false,
    code: "capability_not_available",
    agentId: agent.id,
    action: "focus",
    message: "capability focus is not available",
  });
});
