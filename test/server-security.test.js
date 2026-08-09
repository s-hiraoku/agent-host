import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentRegistry } from "../src/core/registry.js";
import { createAgentServer } from "../src/http/server.js";
import { createApiSecurity } from "../src/http/security.js";

const TOKEN = "configured-test-token";
const authorization = { authorization: `Bearer ${TOKEN}` };

test("accepts a bracketed IPv6 loopback Host", () => {
  const security = createApiSecurity({ apiToken: TOKEN });
  assert.equal(
    security.validateHost({ headers: { host: "[::1]:4777" } }, { port: 4777 }),
    "http://[::1]:4777",
  );
});

function fixtureRegistry(onPrompt = () => {}) {
  return new AgentRegistry([{
    id: "secure-fixture",
    async discover() {
      return [{
        id: "secure:1",
        provider: "fixture",
        source: "secure-fixture",
        name: "Secure agent",
        status: "idle",
        capabilities: { prompt: true },
      }];
    },
    async prompt(agent, text) {
      await onPrompt(text);
      return { ok: true, agentId: agent.id, action: "prompt" };
    },
  }]);
}

async function rawRequest(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: options.path ?? "/health", ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("generates a runtime token and denies cross-origin access by default", async () => {
  const registry = fixtureRegistry();
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000 });
  assert.equal(server.generatedToken, true);
  assert.ok(server.apiToken.length >= 43);
  const address = await server.start();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { origin: "http://dashboard.test" },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "origin_not_allowed");
  } finally {
    await server.stop();
  }
});

test("enforces browser security and emits secret-free action audit events", async () => {
  let promptCalls = 0;
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const registry = fixtureRegistry(async (text) => {
    promptCalls += 1;
    if (text.startsWith("serial-")) {
      activePrompts += 1;
      maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activePrompts -= 1;
    }
  });
  const audits = [];
  registry.events.subscribe((event) => {
    if (event.type === "audit.action") audits.push(event);
  });
  const server = createAgentServer(registry, {
    host: "127.0.0.1",
    port: 0,
    refreshMs: 60_000,
    apiToken: TOKEN,
    allowedOrigins: ["http://dashboard.test"],
  });
  const address = await server.start();
  await registry.refresh();
  const base = `http://127.0.0.1:${address.port}`;
  const actionUrl = `${base}/v1/agents/secure%3A1/prompt`;

  try {
    assert.equal((await fetch(`${base}/v1/agents`)).status, 401);
    assert.equal((await fetch(`${base}/v1/agents`, { headers: authorization })).status, 200);
    assert.equal((await fetch(`${base}/v1/unknown`)).status, 401);
    assert.equal((await fetch(`${base}/v1/unknown`, { headers: authorization })).status, 404);

    const publicReady = await (await fetch(`${base}/ready`)).json();
    assert.equal("adapters" in publicReady, false);
    assert.equal((await fetch(`${base}/v1/adapters`)).status, 401);
    assert.equal((await fetch(`${base}/v1/adapters`, { headers: authorization })).status, 200);

    const missingDetailToken = await fetch(`${base}/v1/agents/secure%3A1`);
    assert.equal(missingDetailToken.status, 401);
    assert.equal((await missingDetailToken.json()).error.code, "authentication_required");

    const missingToken = await fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "not-run" }),
    });
    assert.equal(missingToken.status, 401);
    assert.equal((await missingToken.json()).error.code, "authentication_required");

    const invalidToken = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ text: "not-run" }),
    });
    assert.equal(invalidToken.status, 401);
    assert.equal((await invalidToken.json()).error.code, "invalid_token");
    assert.equal(audits.length, 0);

    const unsupportedType = await fetch(actionUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "text/plain" },
      body: "not-run",
    });
    assert.equal(unsupportedType.status, 415);
    assert.equal((await unsupportedType.json()).error.code, "unsupported_media_type");

    const missingIdempotency = await fetch(actionUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "not-run" }),
    });
    assert.equal(missingIdempotency.status, 400);
    assert.equal((await missingIdempotency.json()).error.code, "invalid_idempotency_key");

    const auditsBeforeCrossOrigin = audits.length;
    const crossOrigin = await fetch(actionUrl, {
      method: "POST",
      headers: { origin: "http://evil.test", "content-type": "text/plain" },
      body: "not-run",
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, "origin_not_allowed");
    assert.equal(audits.length, auditsBeforeCrossOrigin);

    const invalidHost = await rawRequest(address.port, { headers: { host: "evil.test" } });
    assert.equal(invalidHost.status, 421);
    assert.equal(JSON.parse(invalidHost.body).error.code, "invalid_host");

    const preflight = await fetch(actionUrl, {
      method: "OPTIONS",
      headers: {
        origin: "http://dashboard.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, idempotency-key",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://dashboard.test");

    const disallowedPreflight = await fetch(actionUrl, {
      method: "OPTIONS",
      headers: {
        origin: "http://dashboard.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, x-unsafe-header",
      },
    });
    assert.equal(disallowedPreflight.status, 403);
    assert.equal((await disallowedPreflight.json()).error.code, "cors_headers_not_allowed");

    const sameOrigin = await fetch(`${base}/v1/agents`, {
      headers: { ...authorization, origin: base },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get("access-control-allow-origin"), base);

    const allowed = await fetch(actionUrl, {
      method: "POST",
      headers: {
        ...authorization,
        origin: "http://dashboard.test",
        "content-type": "application/json",
        "idempotency-key": "allowed-prompt-0001",
      },
      body: JSON.stringify({ text: "run-once" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://dashboard.test");
    assert.equal(promptCalls, 1);

    const replay = await fetch(actionUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": "allowed-prompt-0001" },
      body: JSON.stringify({ text: "run-once" }),
    });
    assert.equal((await replay.json()).result.replayed, true);
    assert.equal(promptCalls, 1);

    const conflict = await fetch(actionUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": "allowed-prompt-0001" },
      body: JSON.stringify({ text: "different" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "idempotency_conflict");

    const serialRequests = ["a", "b"].map((suffix) => fetch(actionUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": `serialized-prompt-${suffix}` },
      body: JSON.stringify({ text: `serial-${suffix}` }),
    }));
    assert.deepEqual((await Promise.all(serialRequests)).map((response) => response.status), [200, 200]);
    assert.equal(maxActivePrompts, 1);
    assert.equal(promptCalls, 3);

    assert.ok(audits.length >= 10);
    assert.equal(audits.filter((event) => event.phase === "attempted").length, audits.filter((event) => event.phase === "completed").length);
    const serializedAudits = JSON.stringify(audits);
    assert.equal(serializedAudits.includes(TOKEN), false);
    assert.equal(serializedAudits.includes("run-once"), false);
    assert.equal(serializedAudits.includes("not-run"), false);
  } finally {
    await server.stop();
  }
});
