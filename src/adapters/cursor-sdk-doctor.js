import { publicReleaseInfo } from "../release-info.js";
import {
  createCursorSdkFileCredentialSource,
  preflightCursorSdkCredentialFile,
} from "./cursor-sdk-credentials.js";
import { createCursorSdkBridgeDiagnosticClient } from "./cursor-sdk-transport.js";
import { serializePrivateReport } from "../private-report.js";

const CHECK_LIMIT = 6;

export async function diagnoseCursorSdkBridge(configuration, dependencies = {}) {
  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const checks = [];
  const report = {
    schemaVersion: 1,
    kind: "cursor-sdk-bridge-doctor",
    generatedAt,
    agentHostVersion: publicReleaseInfo().serverVersion,
    overall: "fail",
    checks,
  };
  if (!configuration) {
    checks.push({ id: "configuration", status: "fail", reason: "configuration_missing" });
    return { report: boundedReport(report), exitCode: 2 };
  }
  report.expectedBridgeVersion = configuration.sdkVersion;
  report.endpointClass = "loopback";
  checks.push({ id: "configuration", status: "pass" });
  let credentialFailure = false;
  for (const [id, path] of [
    ["connectionCredential", configuration.bearerTokenFile],
    ["agentApiKey", configuration.apiKeyFile],
  ]) {
    try {
      await (dependencies.preflightCredential ?? preflightCursorSdkCredentialFile)(path);
      checks.push({ id, status: "pass" });
    } catch (error) {
      credentialFailure = true;
      checks.push({ id, status: "fail", reason: safeCredentialReason(error?.reason) });
    }
  }
  if (credentialFailure) {
    checks.push({ id: "ping", status: "not-run", reason: "credential_unavailable" });
    checks.push({ id: "version", status: "not-run", reason: "credential_unavailable" });
    return { report: boundedReport(report), exitCode: 2 };
  }

  const makeClient = dependencies.createDiagnosticClient ?? createCursorSdkBridgeDiagnosticClient;
  const client = makeClient({
    endpoint: configuration.endpoint,
    sdkVersion: configuration.sdkVersion,
    bearerTokenSource: (dependencies.createCredentialSource ?? createCursorSdkFileCredentialSource)(
      configuration.bearerTokenFile,
    ),
    timeoutMs: configuration.timeoutMs,
  });
  try {
    const compatibility = await client.inspect();
    checks.push({ id: "ping", status: "pass" });
    checks.push({ id: "version", status: "pass" });
    report.observedBridgeVersion = compatibility.bridgeVersion;
    report.overall = "pass";
    return { report: boundedReport(report), exitCode: 0 };
  } catch (error) {
    const reason = bridgeFailureReason(error);
    if (error?.diagnosticPhase === "version") {
      checks.push({ id: "ping", status: "pass" });
      checks.push({ id: "version", status: "fail", reason });
    } else {
      checks.push({ id: "ping", status: "fail", reason });
      checks.push({ id: "version", status: "not-run", reason: "probe_failed" });
    }
    return { report: boundedReport(report), exitCode: 3 };
  } finally {
    await client.destroy().catch(() => {});
  }
}

function safeCredentialReason(reason) {
  return new Set([
    "credential_missing", "credential_not_regular_file", "credential_wrong_owner",
    "credential_permissions_insecure", "credential_invalid",
  ]).has(reason) ? reason : "credential_invalid";
}

function bridgeFailureReason(error) {
  if (error?.code === "cursor_bridge_unauthenticated") return "authentication_rejected";
  if (error?.code === "cursor_bridge_version_mismatch") return "bridge_version_mismatch";
  if (error?.code === "cursor_bridge_invalid_response" || error?.code === "cursor_bridge_probe_failed") {
    return "protocol_response_invalid";
  }
  if (error?.name === "AbortError" || error?.code === "cursor_bridge_timeout") return "connection_timeout";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"].includes(error?.code)) return "connection_refused";
  return "protocol_unavailable";
}

function boundedReport(report) {
  if (report.checks.length > CHECK_LIMIT) throw new Error("Cursor SDK doctor report exceeded its check limit");
  const result = Object.freeze({ ...report, checks: Object.freeze(report.checks.map((check) => Object.freeze(check))) });
  serializePrivateReport(result);
  return result;
}
