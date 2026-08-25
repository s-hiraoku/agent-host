import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CURSOR_LIVE_CONFIRMATION,
  runCursorSdkLiveConformance,
} from "../scripts/run-cursor-sdk-live-conformance.js";

const COMPLETE_ENV = Object.freeze({
  AGENT_HOST_CURSOR_BRIDGE_TEST_ENDPOINT: "http://127.0.0.1:40555",
  AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE: "/private/token",
  AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE: "/private/key",
  AGENT_HOST_CURSOR_BRIDGE_TEST_AGENT_ID: "dedicated-agent",
  AGENT_HOST_CURSOR_BRIDGE_TEST_CWD: "/private/workspace",
  AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY: "/private/store",
  AGENT_HOST_CURSOR_BRIDGE_TEST_PROFILE: "profile",
  AGENT_HOST_CURSOR_BRIDGE_TEST_PROMPT: "conformance prompt",
});

test("live conformance refuses to run before exact confirmation and complete configuration", async () => {
  let runs = 0;
  const dependencies = { env: {}, run: async () => { runs += 1; return 0; } };
  assert.deepEqual(await runCursorSdkLiveConformance([], dependencies), {
    exitCode: 2, reason: "confirmation_required",
  });
  assert.deepEqual(await runCursorSdkLiveConformance([CURSOR_LIVE_CONFIRMATION, "--report", "report.json"], dependencies), {
    exitCode: 2, reason: "configuration_incomplete",
  });
  assert.equal(runs, 0);
});

test("live conformance rejects a missing report directory before starting the test", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-live-missing-"));
  t.after(() => rm(directory, { recursive: true }));
  let runs = 0;
  const result = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", join(directory, "missing", "report.json"),
  ], {
    env: COMPLETE_ENV,
    preflightCredential: async () => {},
    run: async () => { runs += 1; return 0; },
  });
  assert.deepEqual(result, { exitCode: 2, reason: "report_destination_invalid" });
  assert.equal(runs, 0);
});

test("live conformance writes only bounded sanitized lifecycle evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-live-"));
  t.after(() => rm(directory, { recursive: true }));
  const reportFile = join(directory, "report.json");
  let childEnvironment;
  const result = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", reportFile,
  ], {
    env: COMPLETE_ENV,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    warning() {},
    preflightCredential: async () => {},
    run: async (env) => { childEnvironment = env; return 0; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(childEnvironment.AGENT_HOST_CURSOR_BRIDGE_TEST_CONFIRMED,
    "dedicated-bridge-state-mutation-confirmed-v1");
  const serialized = await readFile(reportFile, "utf8");
  assert.equal(serialized.length < 4096, true);
  for (const secret of Object.values(COMPLETE_ENV)) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(JSON.parse(serialized).checks.map(({ id, status }) => [id, status]), [
    ["confirmation", "pass"], ["configuration", "pass"], ["lifecycle", "pass"],
  ]);
});

test("live conformance validates schema, credentials, and protected report paths before child execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-live-gates-"));
  t.after(() => rm(directory, { recursive: true }));
  let runs = 0;
  let preflights = 0;
  const base = {
    warning() {},
    run: async () => { runs += 1; return 0; },
    preflightCredential: async () => { preflights += 1; },
  };
  const invalid = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", join(directory, "invalid.json"),
  ], { ...base, env: { ...COMPLETE_ENV, AGENT_HOST_CURSOR_BRIDGE_TEST_AGENT_ID: "invalid id" } });
  assert.deepEqual(invalid, { exitCode: 2, reason: "configuration_invalid" });
  const overlap = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", COMPLETE_ENV.AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE,
  ], { ...base, env: COMPLETE_ENV });
  assert.deepEqual(overlap, { exitCode: 2, reason: "report_destination_invalid" });
  const unavailable = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", join(directory, "credential.json"),
  ], {
    ...base,
    env: COMPLETE_ENV,
    preflightCredential: async () => { throw new Error("raw credential path"); },
  });
  assert.deepEqual(unavailable, { exitCode: 2, reason: "credential_unavailable" });
  assert.equal(runs, 0);
  assert.equal(preflights, 0);
});

test("live conformance rejects a dedicated store aliased to the workspace before child execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-cursor-live-store-alias-"));
  t.after(() => rm(directory, { recursive: true }));
  const workspace = join(directory, "workspace");
  const storeAlias = join(directory, "store-alias");
  await mkdir(workspace);
  await symlink(workspace, storeAlias);
  let runs = 0;
  let preflights = 0;
  const result = await runCursorSdkLiveConformance([
    CURSOR_LIVE_CONFIRMATION, "--report", join(directory, "report.json"),
  ], {
    env: {
      ...COMPLETE_ENV,
      AGENT_HOST_CURSOR_BRIDGE_TEST_CWD: workspace,
      AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY: storeAlias,
    },
    preflightCredential: async () => { preflights += 1; },
    run: async () => { runs += 1; return 0; },
  });
  assert.deepEqual(result, { exitCode: 2, reason: "configuration_invalid" });
  assert.equal(preflights, 0);
  assert.equal(runs, 0);
});
