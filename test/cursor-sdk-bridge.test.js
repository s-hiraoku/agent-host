import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCursorSdkBridgeClient } from "../src/adapters/cursor-sdk-transport.js";
import { createCursorSdkCredentialSource } from "../src/adapters/cursor-sdk.js";

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
        agentId: body.agentId, name: "Owned Cursor", status: "AGENT_INFO_STATUS_RUNNING",
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
    agentId: "agent-owned", status: "working", name: "Owned Cursor",
    lastActivityAt: "2026-08-20T00:00:00.000Z",
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
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
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

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}
