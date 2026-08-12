import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMacosServiceController, renderLaunchAgent } from "../src/macos-service.js";

test("LaunchAgent rendering escapes paths and never embeds tokens", () => {
  const plist = renderLaunchAgent({
    nodePath: "/Applications/Node & Tools/node",
    cliPath: "/tmp/<agent>/cli.js",
    configPath: "/tmp/config.json",
    logFile: "/tmp/agent.log",
  });
  assert.match(plist, /Node &amp; Tools/);
  assert.match(plist, /&lt;agent&gt;/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /token|Authorization|AGENT_HOST_API_TOKEN/);
});

test("macOS service controller installs, starts, restarts, stops, and preserves state on uninstall", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-service-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const plistPath = join(home, "Library", "LaunchAgents", "dev.agent-host.plist");
  const configPath = join(home, ".agent-host", "config.json");
  const tokenPath = join(home, ".agent-host", "token");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(home, ".agent-host"), { recursive: true }).then(() => Promise.all([
    writeFile(configPath, "{}"), writeFile(tokenPath, "secret"),
  ])));
  let running = false;
  const calls = [];
  const controller = createMacosServiceController({
    platform: "darwin",
    uid: 501,
    async run(args) {
      calls.push(args);
      if (args[0] === "print" && !running) throw new Error("not loaded");
      if (args[0] === "bootstrap" || args[0] === "kickstart") running = true;
      if (args[0] === "bootout") running = false;
    },
  });
  await controller.install({ plistPath, nodePath: "/usr/bin/node", cliPath: "/opt/agent host/cli.js", configPath, logFile: join(home, ".agent-host", "host.log") });
  assert.match(await readFile(plistPath, "utf8"), /agent host\/cli\.js/);
  await controller.start(plistPath);
  assert.equal((await controller.status(plistPath)).running, true);
  await controller.restart(plistPath);
  await controller.stop(plistPath);
  await controller.uninstall(plistPath);
  await assert.rejects(access(plistPath));
  await access(configPath);
  await access(tokenPath);
  assert.ok(calls.some((args) => args[0] === "bootstrap"));
  assert.ok(calls.some((args) => args[0] === "kickstart"));
  assert.ok(calls.some((args) => args[0] === "bootout"));
});

test("service installation preserves an existing LaunchAgents directory mode", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-service-mode-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const launchAgents = join(home, "Library", "LaunchAgents");
  const plistPath = join(launchAgents, "dev.agent-host.plist");
  await mkdir(launchAgents, { recursive: true, mode: 0o755 });
  await chmod(launchAgents, 0o755);
  const controller = createMacosServiceController({ platform: "darwin", uid: 501, run: async () => ({}) });

  await controller.install({
    plistPath,
    nodePath: "/usr/bin/node",
    cliPath: "/opt/agent-host/src/cli.js",
    configPath: join(home, ".agent-host", "config.json"),
    logFile: join(home, ".agent-host", "agent-host.log"),
  });

  assert.equal((await stat(launchAgents)).mode & 0o777, 0o755);
});
