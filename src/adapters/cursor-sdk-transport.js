import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRedactor } from "../operations/redact.js";
import { claimCursorSdkCredentialSource } from "./cursor-sdk.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONVERSATION_JSON_BYTES = 768 * 1024;
const MAX_CONVERSATION_NODES = 20_000;
const MAX_CONVERSATION_DEPTH = 20;
const MAX_CONVERSATION_KEYS = 40_000;
const MAX_CONVERSATION_STRING_BYTES = 256 * 1024;
const MAX_CONVERSATION_TURNS = 2_000;
const MAX_CONVERSATION_STEPS = 10_000;
const MAX_READ_MESSAGES = 120;
const MAX_READ_MESSAGE_CHARS = 8_192;
const MAX_READ_TEXT_CHARS = 64 * 1024;
const MAX_STREAM_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_FRAMES = 50_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const TERMINAL_RUN_STATUSES = new Set([
  "RUN_LIFECYCLE_STATUS_FINISHED",
  "RUN_LIFECYCLE_STATUS_ERROR",
  "RUN_LIFECYCLE_STATUS_CANCELLED",
  "RUN_LIFECYCLE_STATUS_EXPIRED",
]);
const DEFINITIVE_SEND_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);
const METHODS = Object.freeze({
  ping: "sdk.v1.SdkBridgeControlService/Ping",
  version: "sdk.v1.SdkBridgeControlService/GetVersion",
  create: "sdk.v1.SdkAgentService/CreateAgent",
  resume: "sdk.v1.SdkAgentService/ResumeAgent",
  get: "sdk.v1.SdkAgentService/GetAgent",
  send: "sdk.v1.SdkAgentService/Send",
  getRun: "sdk.v1.SdkAgentService/GetRun",
  getRunConversation: "sdk.v1.SdkAgentService/GetRunConversation",
  cancel: "sdk.v1.SdkAgentService/CancelRun",
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
  const activeRuns = new Map();
  const pendingSends = new Map();
  const streamControllers = new Set();
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) queueMicrotask(() => {
      try { listener({ type: "changed" }); }
      catch { /* listener failures must not terminate stream bookkeeping */ }
    });
  };

  const forgetRun = (agentId, entry) => {
    if (activeRuns.get(agentId) !== entry) return;
    activeRuns.delete(agentId);
    notify();
  };

  const call = async (method, payload, signal, validateResponse, maximumResponseBytes = MAX_RESPONSE_BYTES,
    sanitizeResponse) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_REQUEST_BYTES) throw bridgeError("cursor_bridge_request_too_large");
    try {
      return await bearerToken.use(async (token) => {
        const tokenText = token.toString("utf8");
        const authorization = `Bearer ${tokenText}`;
        const redact = createRedactor({ secrets: [tokenText] });
        const response = await directRequest(new URL(method, endpoint), {
          method: "POST",
          headers: {
            authorization,
            "connect-protocol-version": "1",
            "content-type": "application/json",
          },
          body,
          signal: combinedSignal(signal, timeoutMs),
        });
        const parsed = await boundedJson(response, maximumResponseBytes);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw connectError(parsed, response.statusCode);
        }
        validateResponse?.(parsed);
        return sanitizeResponse ? sanitizeResponse(parsed, tokenText) : redact(parsed);
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
        result = await call(METHODS.get, { agentId, options: { cwd, apiKey } }, signal,
          (response) => assertAgentIdentity(response?.agent, agentId, cwd));
      } catch (error) {
        if (error?.code !== "cursor_bridge_not_found") throw error;
        await resumeLocal({ agentId, cwd, storeDirectory, credential, signal });
        result = await call(METHODS.get, { agentId, options: { cwd, apiKey } }, signal,
          (response) => assertAgentIdentity(response?.agent, agentId, cwd));
      }
      const mapped = mapAgent(result?.agent, agentId);
      const active = activeRuns.get(agentId);
      if (mapped.status !== "working" && active) forgetRun(agentId, active);
      const pending = pendingSends.get(agentId);
      if (["done", "error"].includes(mapped.status) && (pending?.uncertain || pending?.accepted)) {
        pendingSends.delete(agentId);
        pending.controller.abort();
        notify();
      }
      return {
        ...mapped,
        interruptible: mapped.status === "working" && Boolean(active && !active.cancelRequested),
      };
    },
    resumeLocal,
    async sendLocal({ agentId, cwd, storeDirectory, text, credential, signal }) {
      assertReady(ready, destroyed);
      validateOperation(agentId, cwd, storeDirectory, "owned", credential);
      if (typeof text !== "string" || text.trim() === "") {
        throw new TypeError("Cursor SDK Bridge prompt must be non-empty");
      }
      if (activeRuns.has(agentId) || pendingSends.has(agentId)) {
        throw bridgeError("cursor_bridge_agent_busy");
      }
      const controller = new AbortController();
      const pending = { uncertain: false, accepted: false, controller };
      pendingSends.set(agentId, pending);
      streamControllers.add(controller);
      let settled = false;
      let detachAbort = () => {};
      let timer;
      let resolveAccepted;
      let rejectAccepted;
      const accepted = new Promise((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      const settleAccepted = (operation, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachAbort();
        operation(value);
      };
      if (signal?.aborted) controller.abort(signal.reason);
      else if (signal) {
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", abort);
      }
      timer = setTimeout(() => controller.abort(bridgeError("cursor_bridge_timeout")), timeoutMs);
      timer.unref?.();
      const entry = { agentId, runId: undefined, cancelRequested: false, controller };
      let sendAttempted = false;
      void (async () => {
        try {
          await resumeLocal({ agentId, cwd, storeDirectory, credential, signal: controller.signal });
          sendAttempted = true;
          const response = await openStream(METHODS.send, {
            agentId,
            message: { text },
          }, controller.signal);
          let terminal = false;
          let ended = false;
          for await (const frame of connectJsonFrames(response)) {
            if (frame.end) {
              ended = true;
              if (frame.value?.error) throw bridgeError("cursor_bridge_stream_failed");
              continue;
            }
            const identity = streamIdentity(frame.value);
            if (identity) {
              if (identity.agentId !== agentId || !SAFE_RUN_ID.test(identity.runId)) {
                throw bridgeError("cursor_bridge_agent_mismatch");
              }
              if (entry.runId && entry.runId !== identity.runId) {
                throw bridgeError("cursor_bridge_agent_mismatch");
              }
              if (!entry.runId) {
                entry.runId = identity.runId;
                pending.accepted = true;
                activeRuns.set(agentId, entry);
                notify();
                settleAccepted(resolveAccepted, { agentId, runId: identity.runId, status: "working" });
              }
            }
            if (frame.value?.result) terminal = true;
          }
          if (!settled) throw bridgeError("cursor_bridge_prompt_uncertain");
          if (!ended) throw bridgeError("cursor_bridge_stream_failed");
          if (terminal) forgetRun(agentId, entry);
        } catch (error) {
          if (!settled) markSendDisposition(error, !sendAttempted
            ? "not_sent"
            : isDefinitiveSendRejection(error) ? "rejected" : "ambiguous");
          if (!settled && sendAttempted && !isDefinitiveSendRejection(error)) {
            pending.uncertain = true;
            notify();
          }
          if (!settled) settleAccepted(rejectAccepted, error);
          else if (["cursor_bridge_agent_mismatch", "cursor_bridge_invalid_response"].includes(error?.code)) {
            forgetRun(agentId, entry);
          }
        } finally {
          clearTimeout(timer);
          detachAbort();
          if (!pending.uncertain && pendingSends.get(agentId) === pending) {
            pendingSends.delete(agentId);
          }
          streamControllers.delete(controller);
        }
      })();
      return accepted;
    },
    async readRunLocal({ agentId, runId, cwd, storeDirectory, credential, signal }) {
      assertReady(ready, destroyed);
      validateOperation(agentId, cwd, storeDirectory, "owned", credential);
      if (!SAFE_RUN_ID.test(runId ?? "")) throw new TypeError("invalid Cursor SDK Bridge run identity");
      const apiKey = credential.toString("utf8");
      const snapshot = await call(METHODS.getRun, {
        runId,
        options: { runtime: "RUNTIME_LOCAL", cwd, agentId, apiKey },
      }, signal, (response) => assertTerminalRun(response?.run, agentId, runId));
      assertTerminalRun(snapshot.run, agentId, runId);
      const response = await call(
        METHODS.getRunConversation,
        { runId },
        signal,
        (value) => {
          if (typeof value?.conversationJson !== "string") {
            throw bridgeError("cursor_bridge_invalid_response");
          }
        },
        MAX_CONVERSATION_RESPONSE_BYTES,
        (value, bearerSecret) => ({
          ...value,
          conversationJson: redactExactSecret(value.conversationJson, bearerSecret),
        }),
      );
      return { agentId, runId, ...parseConversation(response.conversationJson) };
    },
    async cancelLocal({ agentId, cwd, storeDirectory, credential, signal }) {
      assertReady(ready, destroyed);
      validateOperation(agentId, cwd, storeDirectory, "owned", credential);
      const active = activeRuns.get(agentId);
      if (!active?.runId || active.cancelRequested) {
        throw bridgeError("cursor_bridge_run_not_interruptible");
      }
      active.cancelRequested = true;
      notify();
      await call(METHODS.cancel, { runId: active.runId, agentId }, signal);
      return { agentId, status: "cancelling" };
    },
    onChange(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      await opening?.catch(() => {});
      ready = false;
      for (const controller of streamControllers) controller.abort();
      pendingSends.clear();
      if (activeRuns.size) {
        activeRuns.clear();
        notify();
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      ready = false;
      await opening?.catch(() => {});
      for (const controller of streamControllers) controller.abort();
      pendingSends.clear();
      activeRuns.clear();
      listeners.clear();
      bearerToken.destroy();
    },
  };

  async function openStream(method, payload, signal) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8");
    if (encoded.length > MAX_REQUEST_BYTES) {
      encoded.fill(0);
      throw bridgeError("cursor_bridge_request_too_large");
    }
    const body = Buffer.allocUnsafe(encoded.length + 5);
    body[0] = 0;
    body.writeUInt32BE(encoded.length, 1);
    encoded.copy(body, 5);
    encoded.fill(0);
    try {
      return await bearerToken.use(async (token) => {
        const tokenText = token.toString("utf8");
        const response = await directRequest(new URL(method, endpoint), {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenText}`,
            "connect-protocol-version": "1",
            "content-type": "application/connect+json",
          },
          body,
          signal,
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw connectError(await boundedJson(response, MAX_RESPONSE_BYTES), response.statusCode);
        }
        if (!header(response, "content-type")?.toLowerCase().startsWith("application/connect+json")) {
          throw bridgeError("cursor_bridge_invalid_response");
        }
        return response;
      }, signal);
    } finally {
      body.fill(0);
    }
  }
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

async function* connectJsonFrames(response) {
  let pending = Buffer.alloc(0);
  let total = 0;
  let frames = 0;
  let ended = false;
  try {
    for await (const chunk of response) {
      total += chunk.length;
      if (total > MAX_STREAM_BYTES) throw bridgeError("cursor_bridge_stream_too_large");
      const combined = Buffer.concat([pending, chunk]);
      pending.fill(0);
      pending = combined;
      while (pending.length >= 5) {
        if (ended) throw bridgeError("cursor_bridge_invalid_response");
        const flags = pending[0];
        const length = pending.readUInt32BE(1);
        if ((flags & ~0x02) !== 0 || length > MAX_STREAM_FRAME_BYTES) {
          throw bridgeError("cursor_bridge_invalid_response");
        }
        if (pending.length < 5 + length) break;
        frames += 1;
        if (frames > MAX_STREAM_FRAMES) throw bridgeError("cursor_bridge_stream_too_large");
        const payload = Buffer.from(pending.subarray(5, 5 + length));
        const rest = Buffer.from(pending.subarray(5 + length));
        pending.fill(0);
        pending = rest;
        let value;
        try { value = payload.length ? JSON.parse(payload.toString("utf8")) : {}; }
        catch { throw bridgeError("cursor_bridge_invalid_response"); }
        finally { payload.fill(0); }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw bridgeError("cursor_bridge_invalid_response");
        }
        ended = Boolean(flags & 0x02);
        yield { end: ended, value };
      }
    }
    if (pending.length) throw bridgeError("cursor_bridge_invalid_response");
  } finally {
    pending.fill(0);
  }
}

function streamIdentity(message) {
  const source = message?.result ?? message?.done ?? message?.sdkMessage?.message;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const agentId = exactAlias(source, "agentId", "agent_id");
  const runId = exactAlias(source, "runId", "run_id");
  return typeof agentId === "string" && typeof runId === "string" ? { agentId, runId } : undefined;
}

function exactAlias(value, camel, snake) {
  if (value[camel] !== undefined && value[snake] !== undefined && value[camel] !== value[snake]) {
    throw bridgeError("cursor_bridge_invalid_response");
  }
  return value[camel] ?? value[snake];
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

function isDefinitiveSendRejection(error) {
  return DEFINITIVE_SEND_REJECTION_STATUSES.has(error?.status)
    || error?.code === "cursor_bridge_request_too_large";
}

function assertAgentIdentity(agent, expectedId, expectedCwd) {
  if (!agent || agent.agentId !== expectedId || agent.local?.cwd !== expectedCwd) {
    throw bridgeError("cursor_bridge_agent_mismatch");
  }
}

function assertTerminalRun(run, expectedAgentId, expectedRunId) {
  if (!run || run.agentId !== expectedAgentId || run.runId !== expectedRunId) {
    throw bridgeError("cursor_bridge_agent_mismatch");
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) return;
  if (["RUN_LIFECYCLE_STATUS_CREATING", "RUN_LIFECYCLE_STATUS_RUNNING"].includes(run.status)) {
    throw bridgeError("cursor_bridge_run_not_terminal");
  }
  throw bridgeError("cursor_bridge_invalid_response");
}

function parseConversation(conversationJson) {
  if (Buffer.byteLength(conversationJson, "utf8") > MAX_CONVERSATION_JSON_BYTES) {
    throw bridgeError("cursor_bridge_response_too_large");
  }
  let conversation;
  try { conversation = JSON.parse(conversationJson); }
  catch { throw bridgeError("cursor_bridge_invalid_response"); }
  assertJsonBounds(conversation);
  if (!Array.isArray(conversation) || conversation.length > MAX_CONVERSATION_TURNS) {
    throw bridgeError("cursor_bridge_invalid_response");
  }
  const messages = [];
  let omittedBlockCount = 0;
  let steps = 0;
  for (const item of conversation) {
    if (!plainObject(item) || typeof item.type !== "string") {
      throw bridgeError("cursor_bridge_invalid_response");
    }
    if (item.type === "shellConversationTurn") {
      if (!plainObject(item.turn)) throw bridgeError("cursor_bridge_invalid_response");
      omittedBlockCount += 1;
      continue;
    }
    if (item.type !== "agentConversationTurn" || !plainObject(item.turn)
      || !Array.isArray(item.turn.steps)) {
      throw bridgeError("cursor_bridge_invalid_response");
    }
    if (item.turn.userMessage !== undefined) {
      if (!plainObject(item.turn.userMessage) || typeof item.turn.userMessage.text !== "string") {
        throw bridgeError("cursor_bridge_invalid_response");
      }
      messages.push({ role: "user", text: item.turn.userMessage.text });
    }
    for (const step of item.turn.steps) {
      steps += 1;
      if (steps > MAX_CONVERSATION_STEPS || !plainObject(step) || typeof step.type !== "string") {
        throw bridgeError("cursor_bridge_invalid_response");
      }
      if (step.type === "assistantMessage") {
        if (!plainObject(step.message) || typeof step.message.text !== "string") {
          throw bridgeError("cursor_bridge_invalid_response");
        }
        messages.push({ role: "assistant", text: step.message.text });
      } else {
        omittedBlockCount += 1;
      }
    }
  }
  const bounded = boundMessages(messages);
  return {
    messages: bounded.messages,
    messageCount: messages.length,
    omittedBlockCount,
    truncated: bounded.truncated,
  };
}

function assertJsonBounds(root) {
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  let keys = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > MAX_CONVERSATION_NODES || depth > MAX_CONVERSATION_DEPTH) {
      throw bridgeError("cursor_bridge_invalid_response");
    }
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_CONVERSATION_STRING_BYTES) {
        throw bridgeError("cursor_bridge_response_too_large");
      }
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
    } else if (plainObject(value)) {
      const entries = Object.entries(value);
      keys += entries.length;
      if (keys > MAX_CONVERSATION_KEYS) throw bridgeError("cursor_bridge_invalid_response");
      for (const [key, item] of entries) {
        if (Buffer.byteLength(key, "utf8") > 256) throw bridgeError("cursor_bridge_invalid_response");
        pending.push({ value: item, depth: depth + 1 });
      }
    } else if (value !== null && typeof value !== "boolean" && typeof value !== "number") {
      throw bridgeError("cursor_bridge_invalid_response");
    }
  }
}

function boundMessages(messages) {
  const selected = [];
  let remaining = MAX_READ_TEXT_CHARS;
  let truncated = messages.length > MAX_READ_MESSAGES;
  for (let index = messages.length - 1;
    index >= 0 && selected.length < MAX_READ_MESSAGES && remaining > 0;
    index -= 1) {
    const message = messages[index];
    let text = message.text;
    if (text.length > MAX_READ_MESSAGE_CHARS) {
      text = text.slice(0, MAX_READ_MESSAGE_CHARS);
      truncated = true;
    }
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    remaining -= text.length;
    selected.unshift({ role: message.role, text });
  }
  if (selected.length < messages.length) truncated = true;
  return { messages: selected, truncated };
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function redactExactSecret(value, secret) {
  return typeof value === "string" && typeof secret === "string" && secret !== ""
    ? value.replaceAll(secret, "[REDACTED]")
    : value;
}

function markSendDisposition(error, disposition) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "sendDisposition", {
      value: disposition,
      configurable: true,
    });
  } catch { /* delivery remains ambiguous when error metadata cannot be attached */ }
}

function mapAgent(agent, expectedId) {
  if (!agent || agent.agentId !== expectedId) throw bridgeError("cursor_bridge_agent_mismatch");
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
