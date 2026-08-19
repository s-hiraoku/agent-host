import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRedactor } from "../operations/redact.js";
import { claimCursorSdkCredentialSource } from "./cursor-sdk.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const METHODS = Object.freeze({
  ping: "sdk.v1.SdkBridgeControlService/Ping",
  version: "sdk.v1.SdkBridgeControlService/GetVersion",
  create: "sdk.v1.SdkAgentService/CreateAgent",
  resume: "sdk.v1.SdkAgentService/ResumeAgent",
  get: "sdk.v1.SdkAgentService/GetAgent",
});

export function createCursorSdkBridgeClient(options = {}) {
  const endpoint = loopbackEndpoint(options.endpoint);
  const sdkVersion = version(options.sdkVersion);
  const bearerToken = claimCursorSdkCredentialSource(options.bearerTokenSource);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const namespace = `sdkv1-${createHash("sha256").update(endpoint.origin).digest("hex").slice(0, 16)}`;
  let ready = false;
  let destroyed = false;
  let opening;

  const call = async (method, payload, signal) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_REQUEST_BYTES) throw bridgeError("cursor_bridge_request_too_large");
    try {
      return await bearerToken.use(async (token) => {
        const tokenText = token.toString("utf8");
        const authorization = `Bearer ${tokenText}`;
        const redact = createRedactor({ secrets: [tokenText] });
        const response = await directRequest(new URL(method, endpoint), {
          method: "POST",
          redirect: "error",
          headers: {
            authorization,
            "connect-protocol-version": "1",
            "content-type": "application/json",
          },
          body,
          signal: combinedSignal(signal, timeoutMs),
        });
        const parsed = await boundedJson(response, MAX_RESPONSE_BYTES);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw connectError(parsed, response.statusCode);
        }
        return redact(parsed);
      }, signal);
    } finally {
      body.fill(0);
    }
  };

  const resumeLocal = async ({ agentId, cwd, storeDirectory, credential, signal }) => {
    assertReady(ready, destroyed);
    validateOperation(agentId, cwd, storeDirectory, "owned", credential);
    const resumed = await call(METHODS.resume, {
      agentId,
      options: {
        agentId,
        apiKey: credential.toString("utf8"),
        local: { cwd: [cwd], store: { type: "jsonl", rootDir: storeDirectory } },
      },
    }, signal);
    if (resumed?.agentId !== agentId) throw bridgeError("cursor_bridge_agent_mismatch");
    return { agentId: resumed.agentId };
  };

  const client = {
    namespace,
    sdkVersion,
    async open({ signal } = {}) {
      if (destroyed) throw new Error("Cursor SDK Bridge client is destroyed");
      if (ready) return;
      if (opening) return opening;
      opening = (async () => {
        const ping = await call(METHODS.ping, {}, signal);
        if (ping?.message !== "pong") throw bridgeError("cursor_bridge_probe_failed");
        const info = await call(METHODS.version, {}, signal);
        if (info?.protocolVersion !== "sdk.v1" || info?.bridgeVersion !== sdkVersion
          || !Array.isArray(info.capabilities)) {
          throw bridgeError("cursor_bridge_version_mismatch");
        }
        ready = true;
      })();
      try { await opening; }
      finally { opening = undefined; }
    },
    async createLocal({ agentId, attemptId, cwd, storeDirectory, profile, credential, signal }) {
      assertReady(ready, destroyed);
      validateOperation(agentId, cwd, storeDirectory, profile, credential);
      const apiKey = credential.toString("utf8");
      const result = await call(METHODS.create, {
        options: {
          agentId,
          model: { id: profile },
          apiKey,
          local: { cwd: [cwd], store: { type: "jsonl", rootDir: storeDirectory } },
        },
        idempotencyKey: attemptId,
      }, signal);
      if (result?.agentId !== agentId) throw bridgeError("cursor_bridge_agent_mismatch");
      return { agentId: result.agentId, status: "idle" };
    },
    async getLocal({ agentId, cwd, storeDirectory, credential, signal }) {
      assertReady(ready, destroyed);
      validateOperation(agentId, cwd, storeDirectory, "owned", credential);
      const apiKey = credential.toString("utf8");
      let result;
      try {
        result = await call(METHODS.get, { agentId, options: { cwd, apiKey } }, signal);
      } catch (error) {
        if (error?.code !== "cursor_bridge_not_found") throw error;
        await resumeLocal({ agentId, cwd, storeDirectory, credential, signal });
        result = await call(METHODS.get, { agentId, options: { cwd, apiKey } }, signal);
      }
      return mapAgent(result?.agent, agentId, cwd);
    },
    resumeLocal,
    async close() {
      await opening?.catch(() => {});
      ready = false;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      ready = false;
      await opening?.catch(() => {});
      bearerToken.destroy();
    },
  };
  return Object.freeze(client);
}

function loopbackEndpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError("Cursor SDK Bridge endpoint must be a literal loopback HTTP origin"); }
  const literal = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !literal || !url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new TypeError("Cursor SDK Bridge endpoint must be a literal loopback HTTP origin");
  }
  return url;
}

function version(value) {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) {
    throw new TypeError("Cursor SDK Bridge version must be explicit semver");
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(`${name} must be an integer from 1 to 60000`);
  }
  return value;
}

function validateOperation(agentId, cwd, storeDirectory, profile, credential) {
  if (!SAFE_AGENT_ID.test(agentId ?? "") || typeof cwd !== "string" || cwd === ""
    || typeof storeDirectory !== "string" || storeDirectory === "" || typeof profile !== "string"
    || !Buffer.isBuffer(credential)) {
    throw new TypeError("invalid Cursor SDK Bridge operation");
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedJson(response, maximumBytes) {
  if (!header(response, "content-type")?.toLowerCase().startsWith("application/json")) {
    throw bridgeError("cursor_bridge_invalid_response");
  }
  const declared = Number(header(response, "content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw bridgeError("cursor_bridge_response_too_large");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw bridgeError("cursor_bridge_response_too_large");
    chunks.push(chunk);
  }
  const encoded = Buffer.concat(chunks, bytes);
  let parsed;
  try { parsed = JSON.parse(encoded.toString("utf8")); }
  catch { throw bridgeError("cursor_bridge_invalid_response"); }
  finally { encoded.fill(0); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bridgeError("cursor_bridge_invalid_response");
  }
  return parsed;
}

function directRequest(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: { ...headers, "content-length": body.length },
      signal,
      agent: false,
    }, resolve);
    request.once("error", reject);
    request.end(body);
  });
}

function header(response, name) {
  const value = response.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function connectError(payload, status) {
  const code = payload?.code === "not_found" ? "cursor_bridge_not_found"
    : payload?.code === "unauthenticated" ? "cursor_bridge_unauthenticated"
      : "cursor_bridge_rpc_failed";
  const error = bridgeError(code);
  error.status = Number.isInteger(status) ? status : undefined;
  return error;
}

function mapAgent(agent, expectedId, expectedCwd) {
  if (!agent || agent.agentId !== expectedId || agent.local?.cwd !== expectedCwd) {
    throw bridgeError("cursor_bridge_agent_mismatch");
  }
  const statuses = {
    AGENT_INFO_STATUS_RUNNING: "working",
    AGENT_INFO_STATUS_FINISHED: "done",
    AGENT_INFO_STATUS_ERROR: "error",
  };
  return {
    agentId: expectedId,
    status: statuses[agent.status] ?? "unknown",
    name: typeof agent.name === "string" ? agent.name : undefined,
    lastActivityAt: timestamp(agent.lastModified),
  };
}

function timestamp(value) {
  if (!value || typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function assertReady(ready, destroyed) {
  if (destroyed) throw new Error("Cursor SDK Bridge client is destroyed");
  if (!ready) throw new Error("Cursor SDK Bridge client is not ready");
}

function bridgeError(code) {
  const error = new Error("Cursor SDK Bridge request failed");
  error.code = code;
  return error;
}
