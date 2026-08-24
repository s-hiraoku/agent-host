import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateFileAtomic } from "../src/secure-state.js";
import { publicReleaseInfo } from "../src/release-info.js";
import { serializePrivateReport, validatePrivateReportDestination } from "../src/private-report.js";
import { preflightCursorSdkCredentialFile } from "../src/adapters/cursor-sdk-credentials.js";

export const CURSOR_LIVE_CONFIRMATION = "--confirm-dedicated-bridge-state-will-be-mutated";
const INTERNAL_CONFIRMATION = "dedicated-bridge-state-mutation-confirmed-v1";
const REQUIRED_ENVIRONMENT = Object.freeze([
  "AGENT_HOST_CURSOR_BRIDGE_TEST_ENDPOINT",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_AGENT_ID",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_CWD",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_PROFILE",
  "AGENT_HOST_CURSOR_BRIDGE_TEST_PROMPT",
]);

export async function runCursorSdkLiveConformance(argv, dependencies = {}) {
  const parsed = parseArguments(argv);
  const env = dependencies.env ?? process.env;
  if (!parsed.confirmed) return { exitCode: 2, reason: "confirmation_required" };
  if (!parsed.reportFile) return { exitCode: 2, reason: "report_required" };
  if (REQUIRED_ENVIRONMENT.some((name) => typeof env[name] !== "string" || env[name].trim() === "")) {
    return { exitCode: 2, reason: "configuration_incomplete" };
  }
  const bridgeVersion = env.AGENT_HOST_CURSOR_BRIDGE_TEST_VERSION ?? "1.0.28";
  if (!validLiveConfiguration(env, bridgeVersion)) {
    return { exitCode: 2, reason: "configuration_invalid" };
  }
  let reportFile;
  try {
    reportFile = await validatePrivateReportDestination(resolve(parsed.reportFile), {
      exactPaths: [
        env.AGENT_HOST_CONFIG,
        env.AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE,
        env.AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE,
      ],
      directoryPaths: [env.AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY],
      inspect: dependencies.lstat,
    });
  } catch { return { exitCode: 2, reason: "report_destination_invalid" }; }
  try {
    const preflight = dependencies.preflightCredential ?? preflightCursorSdkCredentialFile;
    await Promise.all([
      preflight(env.AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE),
      preflight(env.AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE),
    ]);
  } catch { return { exitCode: 2, reason: "credential_unavailable" }; }

  (dependencies.warning ?? console.error)(
    "This opt-in test creates durable Cursor agent/run state in the explicitly configured dedicated store; cleanup remains the operator's responsibility.",
  );
  const run = dependencies.run ?? runLiveTest;
  const testExitCode = await run({
    ...env,
    AGENT_HOST_CURSOR_BRIDGE_TEST_CONFIRMED: INTERNAL_CONFIRMATION,
  });
  const report = {
    schemaVersion: 1,
    kind: "cursor-sdk-bridge-live-conformance",
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    agentHostVersion: publicReleaseInfo().serverVersion,
    expectedBridgeVersion: bridgeVersion,
    evidenceClass: "destructive-lifecycle",
    overall: testExitCode === 0 ? "pass" : "fail",
    checks: [
      { id: "confirmation", status: "pass" },
      { id: "configuration", status: "pass" },
      { id: "lifecycle", status: testExitCode === 0 ? "pass" : "fail", reason: testExitCode === 0 ? undefined : "test_failed" },
    ].map((check) => Object.fromEntries(Object.entries(check).filter(([, value]) => value !== undefined))),
  };
  try {
    await (dependencies.writeReport ?? writePrivateFileAtomic)(
      reportFile,
      serializePrivateReport(report),
      { tightenDirectory: false },
    );
  } catch {
    return { exitCode: 4, reason: "report_write_failed", report };
  }
  return { exitCode: testExitCode === 0 ? 0 : 3, report };
}

function validLiveConfiguration(env, bridgeVersion) {
  let endpoint;
  try { endpoint = new URL(env.AGENT_HOST_CURSOR_BRIDGE_TEST_ENDPOINT); }
  catch { return false; }
  const literalLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  const endpointValid = endpoint.protocol === "http:" && literalLoopback && endpoint.port
    && !endpoint.username && !endpoint.password && endpoint.pathname === "/"
    && !endpoint.search && !endpoint.hash && endpoint.origin === env.AGENT_HOST_CURSOR_BRIDGE_TEST_ENDPOINT;
  const safeIdentity = /^[A-Za-z0-9._:-]{1,100}$/;
  const paths = [
    env.AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE,
    env.AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE,
    env.AGENT_HOST_CURSOR_BRIDGE_TEST_CWD,
    env.AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY,
  ];
  return Boolean(endpointValid)
    && typeof bridgeVersion === "string" && bridgeVersion.length <= 64
    && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(bridgeVersion)
    && safeIdentity.test(env.AGENT_HOST_CURSOR_BRIDGE_TEST_AGENT_ID)
    && safeIdentity.test(env.AGENT_HOST_CURSOR_BRIDGE_TEST_PROFILE)
    && paths.every((path) => isAbsolute(path))
    && resolve(paths[0]) !== resolve(paths[1])
    && Buffer.byteLength(env.AGENT_HOST_CURSOR_BRIDGE_TEST_PROMPT, "utf8") <= 32 * 1024;
}

function parseArguments(argv) {
  let confirmed = false;
  let reportFile;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === CURSOR_LIVE_CONFIRMATION) confirmed = true;
    else if (argument === "--report" && argv[index + 1]) reportFile = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return { confirmed, reportFile };
}

function runLiveTest(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-name-pattern=official Cursor SDK Bridge conformance",
      "test/cursor-sdk-bridge.test.js",
    ], { env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun(signal ? 1 : (code ?? 1)));
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runCursorSdkLiveConformance(process.argv.slice(2)).catch(() => ({
    exitCode: 4,
    reason: "internal_error",
  }));
  if (result.reason) console.error(JSON.stringify({ ok: false, reason: result.reason }));
  process.exitCode = result.exitCode;
}
