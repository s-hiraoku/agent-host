import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diagnoseCursorSdkBridge } from "../src/adapters/cursor-sdk-doctor.js";
import { preflightCursorSdkCredentialFile } from "../src/adapters/cursor-sdk-credentials.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-doctor-"));
  t.after(() => rm(directory, { recursive: true }));
  const bearerTokenFile = join(directory, "bridge.token");
  const apiKeyFile = join(directory, "cursor.key");
  await writeFile(bearerTokenFile, "bridge-token\n", { mode: 0o600 });
  await writeFile(apiKeyFile, "cursor-api-key\n", { mode: 0o600 });
  return {
    endpoint: "http://127.0.0.1:40555",
    sdkVersion: "1.0.28",
    bearerTokenFile,
    apiKeyFile,
    helperPath: join(directory, "helper"),
    storeDirectory: join(directory, "store"),
    provenanceFile: join(directory, "provenance.json"),
    timeoutMs: 100,
    targets: [{ id: "owned", cwd: directory, profiles: ["profile"] }],
  };
}

test("doctor exposes only the restricted probe and returns sanitized compatibility evidence", async (t) => {
  const configuration = await fixture(t);
  let factoryOptions;
  let destroyed = 0;
  const result = await diagnoseCursorSdkBridge(configuration, {
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    createDiagnosticClient(options) {
      factoryOptions = options;
      return Object.freeze({
        inspect: async () => ({ protocolVersion: "sdk.v1", bridgeVersion: "1.0.28" }),
        destroy: async () => { destroyed += 1; },
      });
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(factoryOptions).sort(), ["bearerTokenSource", "endpoint", "sdkVersion", "timeoutMs"]);
  assert.equal(destroyed, 1);
  assert.deepEqual(result.report.checks.map(({ id, status }) => [id, status]), [
    ["configuration", "pass"], ["connectionCredential", "pass"], ["agentApiKey", "pass"],
    ["ping", "pass"], ["version", "pass"],
  ]);
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.length < 4096, true);
  for (const value of [configuration.endpoint, configuration.bearerTokenFile, configuration.apiKeyFile,
    configuration.storeDirectory, configuration.provenanceFile]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("doctor rejects credential failures before constructing a network client", async (t) => {
  const configuration = await fixture(t);
  await chmod(configuration.apiKeyFile, 0o644);
  let clients = 0;
  const result = await diagnoseCursorSdkBridge(configuration, {
    createDiagnosticClient() { clients += 1; throw new Error("must not be called"); },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(clients, 0);
  assert.deepEqual(result.report.checks.at(-2), {
    id: "ping", status: "not-run", reason: "credential_unavailable",
  });
  assert.equal(result.report.checks.some((check) => check.reason === "credential_permissions_insecure"), true);
});

test("doctor converts adversarial bridge errors to allowlisted reason codes", async (t) => {
  const configuration = await fixture(t);
  const secret = `${configuration.apiKeyFile}: raw-token agent-123 run-456`;
  const error = Object.assign(new Error(secret), {
    code: "cursor_bridge_version_mismatch",
    diagnosticPhase: "version",
  });
  const result = await diagnoseCursorSdkBridge(configuration, {
    createDiagnosticClient: () => ({ inspect: async () => { throw error; }, destroy: async () => {} }),
  });
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.report.checks.slice(-2), [
    { id: "ping", status: "pass" },
    { id: "version", status: "fail", reason: "bridge_version_mismatch" },
  ]);
  assert.equal(JSON.stringify(result.report).includes(secret), false);
});

test("production credential preflight rejects unsafe modes without repairing them", async (t) => {
  const configuration = await fixture(t);
  await chmod(configuration.bearerTokenFile, 0o644);
  await assert.rejects(preflightCursorSdkCredentialFile(configuration.bearerTokenFile), (error) =>
    error.code === "cursor_sdk_credential_unavailable"
      && error.reason === "credential_permissions_insecure");
});
