import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

test("LaunchAgent can target the stable installed launcher without a release path", () => {
  const plist = renderLaunchAgent({
    launcherPath: "/Users/example/.local/bin/agent-host",
    configPath: "/Users/example/.agent-host/config.json",
    logFile: "/Users/example/.agent-host/agent-host.log.console",
  });
  assert.match(plist, /\.local\/bin\/agent-host/);
  assert.doesNotMatch(plist, /releases\/|src\/cli\.js/);
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
  await chmod(join(home, ".agent-host"), 0o700);
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
  const replaced = await controller.install({
    plistPath,
    launcherPath: join(home, ".local", "bin", "agent-host"),
    configPath,
    logFile: join(home, ".agent-host", "host.log"),
  });
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.running, true);
  assert.match(await readFile(plistPath, "utf8"), /\.local\/bin\/agent-host/);
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

test("service replacement refuses unmanaged files and restores a running plist when reload fails", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-service-replace-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const plistPath = join(home, "Library", "LaunchAgents", "dev.agent-host.plist");
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(plistPath, "unmanaged");
  const controller = createMacosServiceController({ platform: "darwin", uid: 501, run: async () => ({}) });
  await assert.rejects(controller.install({
    plistPath, launcherPath: "/tmp/agent-host", configPath: "/tmp/config", logFile: join(home, "log"),
  }), /unmanaged/);

  const original = renderLaunchAgent({
    launcherPath: "/old/agent-host", configPath: "/tmp/config", logFile: join(home, "log"),
  });
  await writeFile(plistPath, original);
  let loaded = true;
  let bootstrapCalls = 0;
  const failing = createMacosServiceController({
    platform: "darwin",
    uid: 501,
    async run(args) {
      if (args[0] === "print" && !loaded) throw new Error("not loaded");
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "bootstrap") {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) throw new Error("injected reload failure");
        loaded = true;
      }
    },
  });
  await assert.rejects(failing.install({
    plistPath, launcherPath: "/new/agent-host", configPath: "/tmp/config", logFile: join(home, "log"),
  }), /injected reload failure/);
  assert.equal(await readFile(plistPath, "utf8"), original);
  assert.equal(loaded, true);
});
