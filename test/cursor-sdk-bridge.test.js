import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCursorSdkBridgeClient,
  createCursorSdkBridgeDiagnosticClient,
} from "../src/adapters/cursor-sdk-transport.js";
import { CursorSdkBridgeRuntimeAdapter } from "../src/adapters/cursor-sdk-runtime.js";
import { createCursorSdkCredentialSource } from "../src/adapters/cursor-sdk.js";
import { readStrictPrivateFileBufferBounded } from "../src/secure-state.js";

const TOKEN = "bridge-token-value";
const API_KEY = "cursor-api-key-value";

test("bridge client requires an exact literal loopback origin", () => {
  for (const endpoint of [
    "http://localhost:1234", "http://0.0.0.0:1234", "https://127.0.0.1:1234",
    "http://127.0.0.1", "http://127.0.0.1:1234/", "http://user@127.0.0.1:1234",
    "http://127.0.0.1:1234/path", "http://127.0.0.1:1234?x=1",
  ]) {
    assert.throws(() => client(endpoint), /literal loopback HTTP origin/);
  }
  const valid = client("http://127.0.0.1:1234");
  assert.match(valid.namespace, /^sdkv1-[a-f0-9]{16}$/);
});

test("diagnostic client exposes only Ping and GetVersion capability", async (t) => {
  const calls = [];
  const bridge = await fakeBridge((request, _body, response) => {
    calls.push(request.url);
    if (request.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (request.url.endsWith("/GetVersion")) {
      return json(response, 200, { protocolVersion: "sdk.v1", bridgeVersion: "1.0.28", capabilities: [] });
    }
    return json(response, 500, { code: "unexpected" });
  });
  t.after(() => bridge.close());
  const subject = createCursorSdkBridgeDiagnosticClient({
    endpoint: bridge.endpoint,
    sdkVersion: "1.0.28",
    bearerTokenSource: createCursorSdkCredentialSource(TOKEN),
  });
  assert.deepEqual(Object.keys(subject).sort(), ["destroy", "inspect"]);
  assert.deepEqual(await subject.inspect(), { protocolVersion: "sdk.v1", bridgeVersion: "1.0.28" });
  assert.deepEqual(calls, [
    "/sdk.v1.SdkBridgeControlService/Ping",
    "/sdk.v1.SdkBridgeControlService/GetVersion",
  ]);
  await subject.destroy();
});

test("runtime preflights both credential files without repairing unsafe modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-bridge-preflight-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true })));
  for (const unsafe of ["bearerTokenFile", "apiKeyFile"]) {
    const bearerTokenFile = join(directory, `${unsafe}-bridge.token`);
    const apiKeyFile = join(directory, `${unsafe}-cursor.key`);
    await writeFile(bearerTokenFile, TOKEN, { mode: 0o600 });
    await writeFile(apiKeyFile, API_KEY, { mode: 0o600 });
    const unsafePath = unsafe === "bearerTokenFile" ? bearerTokenFile : apiKeyFile;
    await chmod(unsafePath, 0o640);
    const subject = new CursorSdkBridgeRuntimeAdapter({
      endpoint: "http://127.0.0.1:40555", sdkVersion: "1.0.28",
      bearerTokenFile, apiKeyFile, helperPath: "/unreached/helper",
      provenanceFile: "/unreached/state/provenance.json", storeDirectory: "/unreached/store",
      targets: [{ id: "main", cwd: "/unreached/workspace", profiles: ["model"] }],
    });
    await assert.rejects(subject.open(), (error) => error.code === "cursor_sdk_credential_unavailable");
    assert.equal((await lstat(unsafePath)).mode & 0o777, 0o640);
    await subject.destroy();
  }
});

test("configured Cursor SDK runtime exposes the read dispatch boundary", async () => {
  const subject = new CursorSdkBridgeRuntimeAdapter({});
  assert.equal(typeof subject.read, "function");
  assert.throws(() => subject.read({ id: "cursor-sdk:not-open" }), /must be opened before use/);
  await subject.destroy();
});

test("bridge client probes sdk.v1 and performs only explicit owned-agent calls", async (t) => {
  const requests = [];
  const bridge = await fakeBridge(async (req, body, response) => {
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { code: "unauthenticated" });
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: ["local"] });
    }
    if (req.url.endsWith("/CreateAgent")) return json(response, 200, { agentId: body.options.agentId });
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, name: `Owned Cursor ${TOKEN}`, status: "AGENT_INFO_STATUS_RUNNING",
        lastModified: "2026-08-20T00:00:00Z", local: { cwd: body.options.cwd },
      } });
    }
    return json(response, 404, { code: "not_found" });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const createCredential = Buffer.from(API_KEY);
  assert.deepEqual(await subject.createLocal({
    agentId: "agent-owned", attemptId: "attempt:00000000-0000-4000-8000-000000000001",
    cwd: "/workspace", storeDirectory: "/store", profile: "cursor-model", credential: createCredential,
  }), { agentId: "agent-owned", status: "idle" });
  const getCredential = Buffer.from(API_KEY);
  assert.deepEqual(await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store", credential: getCredential,
  }), {
    agentId: "agent-owned", status: "working", name: "Owned Cursor [REDACTED]",
    lastActivityAt: "2026-08-20T00:00:00.000Z", interruptible: false,
  });
  assert.deepEqual(requests.map((entry) => entry.url), [
    "/sdk.v1.SdkBridgeControlService/Ping", "/sdk.v1.SdkBridgeControlService/GetVersion",
    "/sdk.v1.SdkAgentService/CreateAgent", "/sdk.v1.SdkAgentService/GetAgent",
  ]);
  assert.equal(requests.every((entry) => entry.headers["connect-protocol-version"] === "1"), true);
  assert.deepEqual(requests[2].body, {
    options: {
      agentId: "agent-owned", model: { id: "cursor-model" }, apiKey: API_KEY,
      local: { cwd: ["/workspace"], store: { type: "jsonl", rootDir: "/store" } },
    },
    idempotencyKey: "attempt:00000000-0000-4000-8000-000000000001",
  });
  await subject.destroy();
});

test("bridge client resumes only the requested owned agent after not-found", async (t) => {
  let gets = 0;
  const calls = [];
  const bridge = await fakeBridge(async (req, body, response) => {
    calls.push(req.url);
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetAgent") && gets++ === 0) return json(response, 404, { code: "not_found" });
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    return json(response, 200, { agent: {
      agentId: body.agentId, status: "AGENT_INFO_STATUS_FINISHED", local: { cwd: body.options.cwd },
    } });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store", credential: Buffer.from(API_KEY),
  })).status, "done");
  assert.deepEqual(calls.slice(2), [
    "/sdk.v1.SdkAgentService/GetAgent", "/sdk.v1.SdkAgentService/ResumeAgent",
    "/sdk.v1.SdkAgentService/GetAgent",
  ]);
  await subject.destroy();
});

test("bridge client validates the full workspace path before redacting the response", async (t) => {
  const cwd = `/${"nested/".repeat(80)}workspace`;
  let responseCwd = cwd;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    return json(response, 200, { agent: {
      agentId: body.agentId, status: "AGENT_INFO_STATUS_RUNNING", local: { cwd: responseCwd },
    } });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd, storeDirectory: "/store", credential: Buffer.from(API_KEY),
  })).agentId, "agent-owned");
  responseCwd = `${cwd}-different`;
  await assert.rejects(subject.getLocal({
    agentId: "agent-owned", cwd, storeDirectory: "/store", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_mismatch");
  await subject.destroy();
});

test("bridge client reads only bounded user and assistant text from one exact terminal run", async (t) => {
  const requests = [];
  const conversation = [
    {
      type: "agentConversationTurn",
      turn: {
        userMessage: { text: "Fix the failing test" },
        steps: [
          { type: "thinkingMessage", message: { text: "private reasoning" } },
          { type: "toolCall", message: { command: "cat secret.txt", result: "private tool result" } },
          { type: "assistantMessage", message: { text: "The test is fixed." } },
          { type: "futureNonTextStep", message: { payload: "opaque" } },
        ],
      },
    },
    { type: "shellConversationTurn", turn: { shellCommand: { command: "private shell" } } },
  ];
  const bridge = await fakeBridge(async (req, body, response) => {
    requests.push({ url: req.url, body });
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetRun")) return json(response, 200, { run: {
      runId: body.runId, agentId: body.options.agentId, status: "RUN_LIFECYCLE_STATUS_FINISHED",
    } });
    if (req.url.endsWith("/GetRunConversation")) {
      return json(response, 200, { conversationJson: JSON.stringify(conversation) });
    }
    throw new Error(`unexpected request: ${req.url}`);
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.deepEqual(await subject.readRunLocal({
    agentId: "agent-owned", runId: "run-owned-terminal", cwd: "/workspace",
    storeDirectory: "/store", credential: Buffer.from(API_KEY),
  }), {
    agentId: "agent-owned",
    runId: "run-owned-terminal",
    messages: [
      { role: "user", text: "Fix the failing test" },
      { role: "assistant", text: "The test is fixed." },
    ],
    messageCount: 2,
    omittedBlockCount: 4,
    truncated: false,
  });
  assert.deepEqual(requests.slice(2).map(({ url, body }) => ({ url, body })), [
    {
      url: "/sdk.v1.SdkAgentService/GetRun",
      body: {
        runId: "run-owned-terminal",
        options: {
          runtime: "RUNTIME_LOCAL", cwd: "/workspace", agentId: "agent-owned", apiKey: API_KEY,
        },
      },
    },
    {
      url: "/sdk.v1.SdkAgentService/GetRunConversation",
      body: { runId: "run-owned-terminal" },
    },
  ]);
  await subject.destroy();
});

test("bridge client rejects non-terminal, mismatched, and malformed exact-run reads", async (t) => {
  let run = {
    runId: "run-owned", agentId: "agent-owned", status: "RUN_LIFECYCLE_STATUS_RUNNING",
  };
  let conversationJson = "[]";
  let conversationCalls = 0;
  const bridge = await fakeBridge(async (req, _body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetRun")) return json(response, 200, { run });
    conversationCalls += 1;
    return json(response, 200, { conversationJson });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const input = {
    agentId: "agent-owned", runId: "run-owned", cwd: "/workspace",
    storeDirectory: "/store", credential: Buffer.from(API_KEY),
  };
  await assert.rejects(subject.readRunLocal(input), (error) => error.code === "cursor_bridge_run_not_terminal");
  assert.equal(conversationCalls, 0);
  run = { ...run, agentId: "agent-other", status: "RUN_LIFECYCLE_STATUS_FINISHED" };
  await assert.rejects(subject.readRunLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_agent_mismatch");
  assert.equal(conversationCalls, 0);
  run = { ...run, agentId: "agent-owned" };
  for (const malformed of [
    "not json",
    JSON.stringify({ messages: [] }),
    JSON.stringify([{ type: "unknownConversationTurn", turn: {} }]),
    JSON.stringify([{ type: "agentConversationTurn", turn: { steps: [
      { type: "assistantMessage", message: { text: 123 } },
    ] } }]),
    JSON.stringify([{ type: "agentConversationTurn", turn: { steps: [{
      type: "futureNonTextStep",
      message: Array.from({ length: 25 }).reduce((value) => ({ nested: value }), "opaque"),
    }] } }]),
  ]) {
    conversationJson = malformed;
    await assert.rejects(subject.readRunLocal({ ...input, credential: Buffer.from(API_KEY) }),
      (error) => error.code === "cursor_bridge_invalid_response");
  }
  conversationJson = JSON.stringify(["y".repeat(800_000)]);
  await assert.rejects(subject.readRunLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_response_too_large");
  conversationJson = "x".repeat(1_100_000);
  await assert.rejects(subject.readRunLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_response_too_large");
  await subject.destroy();
});

test("bridge client bounds exact-run messages to the newest contiguous text", async (t) => {
  const conversation = Array.from({ length: 70 }, (_, index) => ({
    type: "agentConversationTurn",
    turn: {
      userMessage: { text: `user-${index}` },
      steps: [{
        type: "assistantMessage",
        message: { text: index === 69 ? "x".repeat(9_000) : `assistant-${index}` },
      }],
    },
  }));
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetRun")) return json(response, 200, { run: {
      runId: body.runId, agentId: body.options.agentId, status: "RUN_LIFECYCLE_STATUS_CANCELLED",
    } });
    return json(response, 200, { conversationJson: JSON.stringify(conversation) });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const result = await subject.readRunLocal({
    agentId: "agent-owned", runId: "run-owned", cwd: "/workspace",
    storeDirectory: "/store", credential: Buffer.from(API_KEY),
  });
  assert.equal(result.messageCount, 140);
  assert.equal(result.messages.length, 120);
  assert.deepEqual(result.messages[0], { role: "user", text: "user-10" });
  assert.deepEqual(result.messages.at(-1), { role: "assistant", text: "x".repeat(8_192) });
  assert.equal(result.truncated, true);
  await subject.destroy();
});

test("bridge client sends one owned prompt and cancels only its exact active run", async (t) => {
  const requests = [];
  let sendResponse;
  const bridge = await fakeBridge(async (req, body, response) => {
    requests.push({ url: req.url, body });
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/Send")) {
      sendResponse = response;
      response.writeHead(200, { "content-type": "application/connect+json" });
      response.write(connectFrame({ sdkMessage: {
        type: "system", message: { subtype: "init", agent_id: body.agentId, run_id: "run-owned-1" },
      } }));
      return;
    }
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, status: "AGENT_INFO_STATUS_RUNNING", local: { cwd: body.options.cwd },
      } });
    }
    if (req.url.endsWith("/CancelRun")) {
      assert.deepEqual(body, { runId: "run-owned-1", agentId: "agent-owned" });
      json(response, 200, {});
      sendResponse.write(connectFrame({ result: {
        agentId: "agent-owned", runId: "run-owned-1", status: "RUN_LIFECYCLE_STATUS_CANCELLED",
      } }));
      sendResponse.write(connectFrame({ done: { agentId: "agent-owned", runId: "run-owned-1" } }));
      sendResponse.end(connectFrame({}, 0x02));
      return;
    }
    throw new Error(`unexpected request: ${req.url}`);
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.deepEqual(await subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Fix the failing test", credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-1", status: "working" });
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).interruptible, true);
  assert.deepEqual(await subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-1", status: "cancelling" });
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).interruptible, false);
  assert.equal(requests.filter((entry) => entry.url.endsWith("/Send")).length, 1);
  await subject.destroy();
});

test("bridge client fences uncertain prompt delivery until status proves the agent non-working", async (t) => {
  let sends = 0;
  let status = "AGENT_INFO_STATUS_RUNNING";
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, status, local: { cwd: body.options.cwd },
      } });
    }
    sends += 1;
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.write(connectFrame({ sdkMessage: { type: "assistant" } }), () => response.destroy());
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Do not retry this", credential: Buffer.from(API_KEY),
  }));
  assert.equal(sends, 1);
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Do not duplicate this", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_busy");
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).status, "working");
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Still do not duplicate this", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_busy");
  status = "AGENT_INFO_STATUS_UNSPECIFIED";
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).status, "unknown");
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Unknown status is not proof", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_busy");
  status = "AGENT_INFO_STATUS_FINISHED";
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).status, "done");
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Status now permits a new prompt", credential: Buffer.from(API_KEY),
  }));
  assert.equal(sends, 2);
  await assert.rejects(subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_run_not_interruptible");
  await subject.destroy();
});

test("bridge client retains the send fence after an ambiguous server failure", async (t) => {
  let sends = 0;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, status: "AGENT_INFO_STATUS_FINISHED", local: { cwd: body.options.cwd },
      } });
    }
    sends += 1;
    return json(response, 500, { code: "internal", message: "delivery unknown" });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const input = {
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Do not duplicate a 5xx delivery", credential: Buffer.from(API_KEY),
  };
  await assert.rejects(subject.sendLocal(input), (error) => error.code === "cursor_bridge_rpc_failed");
  await assert.rejects(subject.sendLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_agent_busy");
  assert.equal(sends, 1);
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).status, "done");
  await assert.rejects(subject.sendLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_rpc_failed");
  assert.equal(sends, 2);
  await subject.destroy();
});

test("bridge client classifies pre-send and definitive prompt rejection", async (t) => {
  let mode = "resume-failure";
  let sends = 0;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) {
      if (mode === "resume-failure") return json(response, 401, { code: "unauthenticated" });
      return json(response, 200, { agentId: body.agentId });
    }
    sends += 1;
    return json(response, 422, { code: "invalid_argument" });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const input = {
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "classify rejection", credential: Buffer.from(API_KEY),
  };
  await assert.rejects(subject.sendLocal(input),
    (error) => error.code === "cursor_bridge_unauthenticated" && error.sendDisposition === "not_sent");
  assert.equal(sends, 0);
  mode = "send-rejection";
  await assert.rejects(subject.sendLocal({ ...input, credential: Buffer.from(API_KEY) }),
    (error) => error.code === "cursor_bridge_rpc_failed" && error.sendDisposition === "rejected");
  assert.equal(sends, 1);
  await subject.destroy();
});

for (const statusCode of [408, 499]) {
  test(`bridge client retains the send fence after ambiguous HTTP ${statusCode}`, async (t) => {
    let sends = 0;
    const bridge = await fakeBridge(async (req, body, response) => {
      if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
      if (req.url.endsWith("/GetVersion")) {
        return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
      }
      if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
      if (req.url.endsWith("/GetAgent")) {
        return json(response, 200, { agent: {
          agentId: body.agentId, status: "AGENT_INFO_STATUS_FINISHED", local: { cwd: body.options.cwd },
        } });
      }
      sends += 1;
      return json(response, statusCode, { code: "timeout", message: "delivery unknown" });
    });
    t.after(() => bridge.close());
    const subject = client(bridge.endpoint);
    await subject.open();
    const input = {
      agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
      text: `Do not duplicate an HTTP ${statusCode} delivery`, credential: Buffer.from(API_KEY),
    };
    await assert.rejects(subject.sendLocal(input), (error) => error.code === "cursor_bridge_rpc_failed");
    await assert.rejects(subject.sendLocal({ ...input, credential: Buffer.from(API_KEY) }),
      (error) => error.code === "cursor_bridge_agent_busy");
    assert.equal(sends, 1);
    assert.equal((await subject.getLocal({
      agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
      credential: Buffer.from(API_KEY),
    })).status, "done");
    await assert.rejects(subject.sendLocal({ ...input, credential: Buffer.from(API_KEY) }),
      (error) => error.code === "cursor_bridge_rpc_failed");
    assert.equal(sends, 2);
    await subject.destroy();
  });
}

test("bridge client serializes prompt acceptance before an exact run is known", async (t) => {
  let releaseSend;
  const sendStarted = new Promise((resolve) => { releaseSend = resolve; });
  let sendResponse;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    sendResponse = response;
    response.writeHead(200, { "content-type": "application/connect+json" });
    releaseSend();
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const first = subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "First", credential: Buffer.from(API_KEY),
  });
  await sendStarted;
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Second", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_busy");
  sendResponse.write(connectFrame({ sdkMessage: {
    message: { agentId: "agent-owned", runId: "run-owned-pending" },
  } }));
  assert.deepEqual(await first, { agentId: "agent-owned", runId: "run-owned-pending", status: "working" });
  await subject.destroy();
});

test("bridge client retains an observed exact run for cancellation after stream disconnect", async (t) => {
  let cancelled;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/CancelRun")) {
      cancelled = body;
      return json(response, 200, {});
    }
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.write(connectFrame({ sdkMessage: {
      message: { agentId: "agent-owned", runId: "run-owned-disconnected" },
    } }), () => response.destroy());
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.deepEqual(await subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Keep the exact run", credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-disconnected", status: "working" });
  assert.deepEqual(await subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-disconnected", status: "cancelling" });
  assert.deepEqual(cancelled, { runId: "run-owned-disconnected", agentId: "agent-owned" });
  await subject.destroy();
});

test("bridge client revalidates and cancels one explicit durable run without process memory", async (t) => {
  const requests = [];
  const bridge = await fakeBridge(async (req, body, response) => {
    requests.push({ url: req.url, body });
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetRun")) return json(response, 200, { run: {
      runId: body.runId, agentId: body.options.agentId, status: "RUN_LIFECYCLE_STATUS_RUNNING",
    } });
    if (req.url.endsWith("/CancelRun")) return json(response, 200, {});
    throw new Error(`unexpected request: ${req.url}`);
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  assert.deepEqual(await subject.cancelLocal({
    agentId: "agent-owned", runId: "run-owned-durable", cwd: "/workspace",
    storeDirectory: "/store", credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-durable", status: "cancelling" });
  assert.deepEqual(requests.slice(2), [
    {
      url: "/sdk.v1.SdkAgentService/GetRun",
      body: {
        runId: "run-owned-durable",
        options: {
          runtime: "RUNTIME_LOCAL", cwd: "/workspace", agentId: "agent-owned", apiKey: API_KEY,
        },
      },
    },
    {
      url: "/sdk.v1.SdkAgentService/CancelRun",
      body: { runId: "run-owned-durable", agentId: "agent-owned" },
    },
  ]);
  await subject.destroy();
});

test("bridge client classifies exact-run cancel failures without unsafe retries", async (t) => {
  let mode = "creating";
  let cancelCalls = 0;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/GetRun")) return json(response, 200, { run: {
      runId: body.runId,
      agentId: mode === "mismatch" ? "agent-other" : body.options.agentId,
      status: mode === "creating" ? "RUN_LIFECYCLE_STATUS_CREATING" : "RUN_LIFECYCLE_STATUS_RUNNING",
    } });
    cancelCalls += 1;
    if (mode === "rejected") return json(response, 422, { code: "invalid_argument" });
    return json(response, 500, { code: "internal" });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const input = {
    agentId: "agent-owned", runId: "run-owned-durable", cwd: "/workspace",
    storeDirectory: "/store", credential: Buffer.from(API_KEY),
  };
  for (const preflightMode of ["creating", "mismatch"]) {
    mode = preflightMode;
    await assert.rejects(subject.cancelLocal({ ...input, credential: Buffer.from(API_KEY) }), (error) => {
      assert.equal(error.cancelDisposition, "not_sent");
      return true;
    });
  }
  assert.equal(cancelCalls, 0);
  mode = "rejected";
  await assert.rejects(subject.cancelLocal({ ...input, credential: Buffer.from(API_KEY) }), (error) => {
    assert.equal(error.cancelDisposition, "rejected");
    return true;
  });
  mode = "ambiguous";
  await assert.rejects(subject.cancelLocal({ ...input, credential: Buffer.from(API_KEY) }), (error) => {
    assert.equal(error.cancelDisposition, "ambiguous");
    return true;
  });
  assert.equal(cancelCalls, 2);
  await subject.destroy();
});

test("bridge client releases an accepted send fence after status proves completion", async (t) => {
  let sends = 0;
  let status = "AGENT_INFO_STATUS_RUNNING";
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, status, local: { cwd: body.options.cwd },
      } });
    }
    sends += 1;
    if (sends > 1) return json(response, 500, { code: "internal" });
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.write(connectFrame({ sdkMessage: {
      message: { agentId: body.agentId, runId: "run-owned-completed" },
    } }));
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  const input = {
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "First accepted prompt", credential: Buffer.from(API_KEY),
  };
  assert.deepEqual(await subject.sendLocal(input), {
    agentId: "agent-owned", runId: "run-owned-completed", status: "working",
  });
  status = "AGENT_INFO_STATUS_FINISHED";
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).status, "done");
  await assert.rejects(subject.sendLocal({
    ...input, text: "Allowed after completion", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_rpc_failed");
  assert.equal(sends, 2);
  await subject.destroy();
});

test("bridge client disables repeat cancellation before an ambiguous CancelRun response", async (t) => {
  let cancellations = 0;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    if (req.url.endsWith("/Send")) {
      response.writeHead(200, { "content-type": "application/connect+json" });
      response.write(connectFrame({ sdkMessage: {
        message: { agentId: "agent-owned", runId: "run-owned-ambiguous-cancel" },
      } }));
      return;
    }
    if (req.url.endsWith("/GetAgent")) {
      return json(response, 200, { agent: {
        agentId: body.agentId, status: "AGENT_INFO_STATUS_RUNNING", local: { cwd: body.options.cwd },
      } });
    }
    cancellations += 1;
    response.socket.destroy();
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  await subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Cancel exactly once", credential: Buffer.from(API_KEY),
  });
  await assert.rejects(subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }));
  assert.equal((await subject.getLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  })).interruptible, false);
  await assert.rejects(subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_run_not_interruptible");
  assert.equal(cancellations, 1);
  await subject.destroy();
});

test("bridge client rejects a mismatched stream identity without enabling cancellation", async (t) => {
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.end(Buffer.concat([
      connectFrame({ sdkMessage: { message: { agentId: "agent-other", runId: "run-other" } } }),
      connectFrame({}, 0x02),
    ]));
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  await assert.rejects(subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Reject mismatch", credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_agent_mismatch");
  await assert.rejects(subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_run_not_interruptible");
  await subject.destroy();
});

test("bridge client revokes cancellation when an accepted stream later conflicts", async (t) => {
  let sendResponse;
  const bridge = await fakeBridge(async (req, body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    if (req.url.endsWith("/ResumeAgent")) return json(response, 200, { agentId: body.agentId });
    sendResponse = response;
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.write(connectFrame({ sdkMessage: {
      message: { agentId: "agent-owned", runId: "run-owned-first" },
    } }));
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  let changes = 0;
  let resolveRevoked;
  const revoked = new Promise((resolve) => { resolveRevoked = resolve; });
  const unsubscribe = subject.onChange(() => {
    changes += 1;
    if (changes === 2) resolveRevoked();
  });
  assert.deepEqual(await subject.sendLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    text: "Revoke on conflict", credential: Buffer.from(API_KEY),
  }), { agentId: "agent-owned", runId: "run-owned-first", status: "working" });
  sendResponse.end(connectFrame({ sdkMessage: {
    message: { agentId: "agent-owned", runId: "run-owned-conflict" },
  } }));
  await revoked;
  await assert.rejects(subject.cancelLocal({
    agentId: "agent-owned", cwd: "/workspace", storeDirectory: "/store",
    credential: Buffer.from(API_KEY),
  }), (error) => error.code === "cursor_bridge_run_not_interruptible");
  unsubscribe();
  await subject.destroy();
});

test("bridge client fails closed on version, response, and RPC errors without exposing credentials", async (t) => {
  const bridge = await fakeBridge(async (req, _body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    return json(response, 200, { bridgeVersion: "1.0.27", protocolVersion: "sdk.v1", capabilities: [] });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await assert.rejects(subject.open(), (error) => {
    assert.equal(error.code, "cursor_bridge_version_mismatch");
    assert.equal(String(error).includes(TOKEN), false);
    return true;
  });
  await subject.destroy();
});

test("bridge client bounds responses and never retries a failed transport call", async (t) => {
  let calls = 0;
  const bridge = await fakeBridge(async (_req, _body, response) => {
    calls += 1;
    json(response, 200, { message: "x".repeat(70_000) });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await assert.rejects(subject.open(), (error) => error.code === "cursor_bridge_response_too_large");
  assert.equal(calls, 1);
  await subject.destroy();
});

test("bridge client maps authentication failure without exposing or retrying credentials", async (t) => {
  let calls = 0;
  const bridge = await fakeBridge(async (_req, _body, response) => {
    calls += 1;
    json(response, 401, { code: "unauthenticated", message: TOKEN });
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await assert.rejects(subject.open(), (error) => {
    assert.equal(error.code, "cursor_bridge_unauthenticated");
    assert.equal(String(error).includes(TOKEN), false);
    return true;
  });
  assert.equal(calls, 1);
  await subject.destroy();
});

test("bridge client times out and does not retry an ambiguous request", async (t) => {
  let calls = 0;
  const server = createServer(async (request) => {
    calls += 1;
    for await (const _chunk of request) { /* consume the issued request */ }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const subject = createCursorSdkBridgeClient({
    endpoint: `http://127.0.0.1:${port}`,
    sdkVersion: "1.0.28",
    timeoutMs: 20,
    bearerTokenSource: createCursorSdkCredentialSource(TOKEN),
  });
  await assert.rejects(subject.open());
  assert.equal(calls, 1);
  await subject.destroy();
});

test("bridge client never retries an ambiguous CreateAgent disconnect", async (t) => {
  let creates = 0;
  const bridge = await fakeBridge(async (req, _body, response) => {
    if (req.url.endsWith("/Ping")) return json(response, 200, { message: "pong" });
    if (req.url.endsWith("/GetVersion")) {
      return json(response, 200, { bridgeVersion: "1.0.28", protocolVersion: "sdk.v1", capabilities: [] });
    }
    creates += 1;
    response.socket.destroy();
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await subject.open();
  await assert.rejects(subject.createLocal({
    agentId: "agent-owned", attemptId: "attempt:00000000-0000-4000-8000-000000000001",
    cwd: "/workspace", storeDirectory: "/store", profile: "cursor-model", credential: Buffer.from(API_KEY),
  }));
  assert.equal(creates, 1);
  await subject.destroy();
});

test("bridge client rejects malformed response media without interpreting it", async (t) => {
  const bridge = await fakeBridge(async (_req, _body, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end('{"message":"pong"}');
  });
  t.after(() => bridge.close());
  const subject = client(bridge.endpoint);
  await assert.rejects(subject.open(), (error) => error.code === "cursor_bridge_invalid_response");
  await subject.destroy();
});

test("official Cursor SDK Bridge conformance is available as an explicit live opt-in", {
  skip: !liveConfiguration()
    || process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_CONFIRMED !== "dedicated-bridge-state-mutation-confirmed-v1",
}, async () => {
  const config = liveConfiguration();
  const subject = createCursorSdkBridgeClient({
    endpoint: config.endpoint,
    sdkVersion: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_VERSION ?? "1.0.28",
    bearerTokenSource: createCursorSdkCredentialSource(
      async () => trimBuffer(await readStrictPrivateFileBufferBounded(config.tokenFile, 16_385)),
    ),
  });
  const apiKeyFile = await readStrictPrivateFileBufferBounded(config.apiKeyFile, 16_385);
  const apiKey = trimBuffer(apiKeyFile);
  try {
    await subject.open();
    await subject.createLocal({
      agentId: config.agentId,
      attemptId: "attempt:00000000-0000-4000-8000-000000000001",
      cwd: config.cwd,
      storeDirectory: config.storeDirectory,
      profile: config.profile,
      credential: apiKey,
    });
    assert.equal((await subject.getLocal({ ...config, credential: apiKey })).agentId, config.agentId);
    assert.equal((await subject.resumeLocal({ ...config, credential: apiKey })).agentId, config.agentId);
    const sent = await subject.sendLocal({ ...config, text: config.prompt, credential: apiKey });
    assert.equal(sent.agentId, config.agentId);
    assert.match(sent.runId, /^[A-Za-z0-9._:-]{1,200}$/);
    assert.equal((await subject.getLocal({ ...config, credential: apiKey })).agentId, config.agentId);
    assert.equal((await subject.cancelLocal({ ...config, credential: apiKey })).agentId, config.agentId);
    const read = await waitForTerminalRead(subject, { ...config, runId: sent.runId, credential: apiKey });
    assert.equal(read.agentId, config.agentId);
    assert.equal(read.runId, sent.runId);
    assert.equal(read.messages.every((message) => ["user", "assistant"].includes(message.role)), true);
  } finally {
    apiKeyFile.fill(0);
    await subject.destroy();
  }
});

function client(endpoint) {
  return createCursorSdkBridgeClient({
    endpoint,
    sdkVersion: "1.0.28",
    bearerTokenSource: createCursorSdkCredentialSource(TOKEN),
  });
}

async function fakeBridge(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      const encoded = Buffer.concat(chunks);
      body = request.headers["content-type"]?.startsWith("application/connect+json")
        ? decodeConnectRequest(encoded)
        : JSON.parse(encoded.toString("utf8"));
    }
    catch { return json(response, 400, { code: "invalid_argument" }); }
    await handler(request, body, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function decodeConnectRequest(encoded) {
  if (encoded.length < 5 || encoded[0] !== 0 || encoded.readUInt32BE(1) !== encoded.length - 5) {
    throw new Error("invalid Connect request frame");
  }
  return JSON.parse(encoded.subarray(5).toString("utf8"));
}

function connectFrame(value, flags = 0) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 5);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

function liveConfiguration() {
  const config = {
    endpoint: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_ENDPOINT,
    tokenFile: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_TOKEN_FILE,
    apiKeyFile: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_API_KEY_FILE,
    agentId: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_AGENT_ID,
    cwd: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_CWD,
    storeDirectory: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_STORE_DIRECTORY,
    profile: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_PROFILE,
    prompt: process.env.AGENT_HOST_CURSOR_BRIDGE_TEST_PROMPT,
  };
  return Object.values(config).every(Boolean) ? config : undefined;
}

function trimBuffer(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[start])) start += 1;
  while (end > start && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[end - 1])) end -= 1;
  return bytes.subarray(start, end);
}

async function waitForTerminalRead(subject, input) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await subject.readRunLocal(input); }
    catch (error) {
      if (error?.code !== "cursor_bridge_run_not_terminal") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}
