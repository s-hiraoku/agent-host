import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfiguration, parseCommandLine, serializableConfiguration } from "../src/config.js";

test("configuration precedence is CLI over environment over file over defaults", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-config-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const configFile = join(home, "settings", "config.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(home, "settings"), { recursive: true }));
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1,
    port: 4000,
    refreshMs: 2_000,
    enabledAdapters: ["process"],
    tokenFile: "token",
    lockFile: "host.lock",
  }));

  const { configuration } = await loadConfiguration({
    cli: { configFile, port: "6000" },
    env: { AGENT_HOST_PORT: "5000", AGENT_HOST_LOG_LEVEL: "debug" },
    homeDirectory: home,
  });

  assert.equal(configuration.port, 6000);
  assert.equal(configuration.refreshMs, 2_000);
  assert.equal(configuration.logLevel, "debug");
  assert.deepEqual(configuration.enabledAdapters, ["process"]);
  assert.equal(configuration.tokenFile, join(home, "settings", "token"));
  assert.equal(configuration.lockFile, join(home, "settings", "host.lock"));
  assert.equal(configuration.logFile, join(home, "settings", "agent-host.log"));

  const cwdRelative = await loadConfiguration({
    cli: { configFile, tokenFile: "cli-token" },
    env: { AGENT_HOST_LOCK_FILE: "env-lock" },
    homeDirectory: home,
  });
  assert.equal(cwdRelative.configuration.tokenFile, join(process.cwd(), "cli-token"));
  assert.equal(cwdRelative.configuration.lockFile, join(process.cwd(), "env-lock"));

  const dashboardOnly = await loadConfiguration({
    cli: { configFile, dashboardDirectory: "dashboard" }, env: {}, homeDirectory: home,
  });
  assert.equal(dashboardOnly.configuration.dashboardDirectory, join(process.cwd(), "dashboard"));
  assert.equal("dashboardDirectory" in serializableConfiguration(dashboardOnly.configuration), false);
});

test("configuration rejects unknown keys and invalid boundaries", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-config-invalid-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true })));
  const configFile = join(home, "config.json");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, porrt: 4777 }));
  await assert.rejects(loadConfiguration({ cli: { configFile }, env: {}, homeDirectory: home }), /unknown configuration key: porrt/);
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, dashboardDirectory: "dashboard" }));
  await assert.rejects(loadConfiguration({ cli: { configFile }, env: {}, homeDirectory: home }), /unknown configuration key: dashboardDirectory/);
  await unlink(configFile);
  await writeFile(configFile, "{}");
  await assert.rejects(loadConfiguration({ cli: { configFile }, env: {}, homeDirectory: home }), /schemaVersion is required/);
  await unlink(configFile);

  for (const cli of [
    { bind: "0.0.0.0" },
    { port: "0" },
    { refreshMs: "0" },
    { enabledAdapters: "codex,codex" },
    { enabledAdapters: "missing" },
    { codexTransport: "control", codexSocket: "" },
    { logLevel: "verbose" },
    { dashboardUrl: "http://localhost:3000/" },
  ]) {
    await assert.rejects(loadConfiguration({ cli, env: {}, homeDirectory: home, allowMissingExplicit: true }));
  }
});

test("command-line parsing preserves positional action payloads and repeated origins", () => {
  assert.deepEqual(parseCommandLine([
    "action", "codex:1", "prompt", "--allowed-origin", "http://localhost:3000", "--", '{"text":"--fix"}',
  ]), {
    command: "action",
    positionals: ["codex:1", "prompt", '{"text":"--fix"}'],
    options: { allowedOrigins: ["http://localhost:3000"] },
  });
  assert.throws(() => parseCommandLine(["serve", "--unknown"]), /unknown option/);
});
