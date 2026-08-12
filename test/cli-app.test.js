import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli-app.js";
import { inspectInstanceLock } from "../src/instance-lock.js";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("fresh-home init creates versioned config and private token without printing the secret", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-init-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const lines = [];
  assert.equal(await runCli(["init"], { homeDirectory: home, env: {}, output: (line) => lines.push(line) }), 0);
  const configFile = join(home, ".agent-host", "config.json");
  const tokenFile = join(home, ".agent-host", "token");
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).schemaVersion, 1);
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert.equal(token.length, 43);
  assert.doesNotMatch(lines.join("\n"), new RegExp(token));
  assert.equal((await lstat(configFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
});

test("foreground serve owns the lock and releases it after SIGTERM", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-serve-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const processLike = new EventEmitter();
  let stopped = false;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const running = runCli(["serve"], {
    homeDirectory: home,
    env: {},
    processLike,
    output() {},
    makeRegistry: () => ({}),
    makeServer: () => ({ async start() { signalStarted(); }, async stop() { stopped = true; } }),
  });
  await started;
  const lockFile = join(home, ".agent-host", "agent-host.lock");
  await waitFor(async () => (await inspectInstanceLock(lockFile)).state === "running");
  assert.equal((await inspectInstanceLock(lockFile)).state, "running");
  processLike.emit("SIGTERM");
  assert.equal(await running, 0);
  assert.equal(stopped, true);
  assert.equal((await inspectInstanceLock(lockFile)).state, "stopped");
});

test("foreground startup failure releases its lock and reports a port conflict", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-port-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const conflict = Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
  await assert.rejects(runCli(["serve", "--port", "4888"], {
    homeDirectory: home,
    env: {},
    output() {},
    makeRegistry: () => ({}),
    makeServer: () => ({ async start() { throw conflict; }, async stop() {} }),
  }), /port 4888 is already in use/);
  assert.equal((await inspectInstanceLock(join(home, ".agent-host", "agent-host.lock"))).state, "stopped");
});

test("token rotation is refused while a daemon owns the lock", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-rotate-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const processLike = new EventEmitter();
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const running = runCli(["serve"], {
    homeDirectory: home,
    env: {},
    processLike,
    output() {},
    makeRegistry: () => ({}),
    makeServer: () => ({ async start() { signalStarted(); }, async stop() {} }),
  });
  await started;
  await waitFor(async () => (await inspectInstanceLock(join(home, ".agent-host", "agent-host.lock"))).state === "running");
  await assert.rejects(runCli(["token", "rotate"], { homeDirectory: home, env: {}, output() {} }), /stop agent-host/);
  processLike.emit("SIGINT");
  await running;
  assert.equal(await runCli(["token", "rotate"], { homeDirectory: home, env: {}, output() {} }), 0);
  await access(join(home, ".agent-host", "token"));
});

test("service lifecycle commands initialize state and delegate without deleting configuration", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-service-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const calls = [];
  const service = {
    async install(options) { calls.push(["install", options]); return { installed: true, running: false }; },
    async start(path) { calls.push(["start", path]); return { installed: true, running: true }; },
    async stop(path) { calls.push(["stop", path]); return { installed: true, running: false }; },
    async restart(path) { calls.push(["restart", path]); return { installed: true, running: true }; },
    async uninstall(path) { calls.push(["uninstall", path]); return { installed: false, running: false }; },
  };
  const dependencies = { homeDirectory: home, env: {}, output() {}, service, platform: "darwin" };

  assert.equal(await runCli(["service", "install"], dependencies), 0);
  assert.equal(await runCli(["start"], dependencies), 0);
  assert.equal(await runCli(["restart"], dependencies), 0);
  assert.equal(await runCli(["stop"], dependencies), 0);
  assert.equal(await runCli(["service", "uninstall"], dependencies), 0);

  await access(join(home, ".agent-host", "config.json"));
  await access(join(home, ".agent-host", "token"));
  assert.deepEqual(calls.map(([operation]) => operation), ["install", "start", "restart", "stop", "uninstall"]);
  assert.equal(calls[0][1].nodePath, process.execPath);
  assert.match(calls[0][1].configPath, /\.agent-host\/config\.json$/);
});

test("stop remains available when configuration is malformed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-cli-recovery-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(home, ".agent-host"), { recursive: true }));
  await writeFile(join(home, ".agent-host", "config.json"), "not-json\n");
  let stoppedPath;
  const service = { async stop(path) { stoppedPath = path; return { installed: true, running: false }; } };

  assert.equal(await runCli(["stop"], { homeDirectory: home, env: {}, output() {}, service }), 0);
  assert.match(stoppedPath, /Library\/LaunchAgents\/dev\.agent-host\.plist$/);
});
