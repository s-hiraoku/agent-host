import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { AgentEventBus } from "../src/core/event-bus.js";
import { AgentRegistry } from "../src/core/registry.js";
import { createAgentServer } from "../src/http/server.js";

test("server shutdown closes active SSE clients before registry cleanup", { timeout: 2000 }, async () => {
  let closeCalls = 0;
  const registry = {
    revision: 0,
    events: new AgentEventBus(),
    async refresh() { return []; },
    async close() { closeCalls += 1; },
  };
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000 });
  const address = await server.start();

  let response;
  let ready;
  const request = get({ host: "127.0.0.1", port: address.port, path: "/v1/events" });
  await new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (res) => {
      response = res;
      res.setEncoding("utf8");
      res.once("data", (chunk) => {
        ready = chunk;
        resolve();
      });
    });
  });
  assert.match(ready, /event: ready/);
  assert.match(ready, /"apiVersion":"1"/);
  assert.match(ready, /"revision":0/);
  assert.match(ready, /"sequence":0/);

  const eventData = new Promise((resolve) => response.once("data", resolve));
  registry.events.emit({
    type: "agent.updated",
    snapshotRevision: 1,
    agent: { id: "fixture:1", capabilities: {}, metadata: { secret: "must not leave the host" } },
  });
  const event = await eventData;
  assert.match(event, /event: agent.updated/);
  assert.match(event, /"apiVersion":"1"/);
  assert.match(event, /"snapshotRevision":1/);
  assert.match(event, /"sequence":1/);
  assert.doesNotMatch(event, /must not leave the host/);

  const ended = response.complete
    ? Promise.resolve()
    : new Promise((resolve) => response.once("end", resolve));
  await server.stop();
  await ended;
  assert.equal(closeCalls, 1);
  assert.equal(response.complete, true);
});

test("serves bounded agent summaries, details, filters, and structured errors", async () => {
  let suffix = "";
  const adapter = {
    id: "fixture",
    async discover() {
      const now = new Date().toISOString();
      return [
        {
          id: "fixture:alpha",
          provider: "codex",
          source: "fixture",
          name: `Alpha${suffix}`,
          status: "blocked",
          capabilities: { prompt: true, approve: true, reject: true },
          cwd: "/work/alpha",
          sessionId: "session-alpha",
          pendingApprovals: [{
            approvalId: "approval-1",
            method: "item/commandExecution/requestApproval",
            command: "npm test",
            reason: "Run tests",
          }],
          metadata: { secretProviderPayload: "must not leave the host" },
          discoveredAt: now,
          updatedAt: now,
        },
        {
          id: "fixture:beta",
          provider: "herdr",
          source: "fixture",
          name: "Beta",
          status: "idle",
          capabilities: { prompt: true },
          cwd: "/work/beta",
          metadata: { secretProviderPayload: "must not leave the host" },
          discoveredAt: now,
          updatedAt: now,
        },
        {
          id: "fixture:gamma",
          provider: "codex",
          source: "fixture",
          name: "Gamma",
          status: "working",
          capabilities: { prompt: true, interrupt: true },
          cwd: "/other/gamma",
          metadata: { secretProviderPayload: "must not leave the host" },
          discoveredAt: now,
          updatedAt: now,
        },
      ];
    },
    async prompt(agent, text) { return { ok: true, agentId: agent.id, action: "prompt", data: text }; },
  };
  const registry = new AgentRegistry([adapter]);
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000 });
  const address = await server.start();
  await registry.refresh();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const firstResponse = await fetch(`${base}/v1/agents?provider=codex&limit=1`);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.apiVersion, "1");
    assert.equal(first.revision, 1);
    assert.equal(first.agents.length, 1);
    assert.equal(first.page.total, 2);
    assert.equal(first.agents[0].id, "fixture:alpha");
    assert.equal(first.agents[0].pendingApprovalCount, 1);
    assert.deepEqual(Object.keys(first.agents[0].capabilities), [
      "prompt", "sendKeys", "approve", "reject", "interrupt", "focus", "read",
    ]);
    assert.equal("metadata" in first.agents[0], false);
    assert.ok(first.page.nextCursor);

    const second = await (await fetch(
      `${base}/v1/agents?provider=codex&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
    )).json();
    assert.equal(second.agents[0].id, "fixture:gamma");
    assert.equal(second.page.nextCursor, undefined);

    const filtered = await (await fetch(`${base}/v1/agents?status=idle&cwd=WORK&q=beta`)).json();
    assert.deepEqual(filtered.agents.map((agent) => agent.id), ["fixture:beta"]);

    const cwdPage = await (await fetch(`${base}/v1/agents?cwd=%2FWORK&limit=1`)).json();
    const cwdNext = await fetch(
      `${base}/v1/agents?cwd=%2Fwork&limit=1&cursor=${encodeURIComponent(cwdPage.page.nextCursor)}`,
    );
    assert.equal(cwdNext.status, 200);
    assert.equal((await cwdNext.json()).agents.length, 1);

    const detail = await (await fetch(`${base}/v1/agents/${encodeURIComponent("fixture:alpha")}`)).json();
    assert.equal(detail.agent.sessionId, "session-alpha");
    assert.equal(detail.agent.pendingApprovals[0].approvalId, "approval-1");
    assert.equal("metadata" in detail.agent, false);
    assert.equal(JSON.stringify(detail).includes("secretProviderPayload"), false);

    const invalidLimitResponse = await fetch(`${base}/v1/agents?limit=0`);
    assert.equal(invalidLimitResponse.status, 400);
    assert.equal((await invalidLimitResponse.json()).error.code, "invalid_limit");

    const missingResponse = await fetch(`${base}/v1/agents/missing`);
    assert.equal(missingResponse.status, 404);
    assert.equal((await missingResponse.json()).error.code, "agent_not_found");

    const actionResponse = await fetch(`${base}/v1/agents/missing/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(actionResponse.status, 404);
    assert.equal((await actionResponse.json()).error.code, "agent_not_found");

    const successResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const success = await successResponse.json();
    assert.equal(successResponse.status, 200);
    assert.deepEqual(success, {
      apiVersion: "1",
      result: { ok: true, agentId: "fixture:alpha", action: "prompt", data: "hello" },
    });

    suffix = " changed";
    await fetch(`${base}/v1/refresh`, { method: "POST" });
    const staleResponse = await fetch(
      `${base}/v1/agents?provider=codex&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
    );
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).error.code, "stale_cursor");

    const invalidJsonResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal((await invalidJsonResponse.json()).error.code, "invalid_json");

    const malformedIdResponse = await fetch(`${base}/v1/agents/%ZZ`);
    assert.equal(malformedIdResponse.status, 400);
    assert.equal((await malformedIdResponse.json()).error.code, "invalid_agent_id");

    const oversizedResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1_000_000) }),
    });
    assert.equal(oversizedResponse.status, 413);
    assert.equal((await oversizedResponse.json()).error.code, "payload_too_large");
  } finally {
    await server.stop();
  }
});

test("keeps the default list response bounded with 1,000 agents", async () => {
  const largeMetadata = "x".repeat(10_000);
  const adapter = {
    id: "large-fixture",
    async discover() {
      return Array.from({ length: 1_000 }, (_, index) => ({
        id: `fixture:${index}`,
        provider: "fixture",
        source: "large-fixture",
        name: `Agent ${String(index).padStart(4, "0")}`,
        status: "idle",
        capabilities: { prompt: false },
        metadata: { largeMetadata },
      }));
    },
  };
  const registry = new AgentRegistry([adapter]);
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000 });
  const address = await server.start();
  await registry.refresh();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agents`);
    const body = await response.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.agents.length, 50);
    assert.equal(parsed.page.total, 1_000);
    assert.ok(parsed.page.nextCursor);
    assert.ok(Buffer.byteLength(body) < 100_000, `response was ${Buffer.byteLength(body)} bytes`);
    assert.equal(body.includes(largeMetadata), false);

    const maximumResponse = await fetch(`http://127.0.0.1:${address.port}/v1/agents?limit=200`);
    const maximumBody = await maximumResponse.text();
    const maximumPage = JSON.parse(maximumBody);
    assert.equal(maximumPage.agents.length, 200);
    assert.equal(maximumPage.page.limit, 200);
    assert.ok(maximumPage.page.nextCursor);
    assert.ok(Buffer.byteLength(maximumBody) < 400_000, `response was ${Buffer.byteLength(maximumBody)} bytes`);
    assert.equal(maximumBody.includes(largeMetadata), false);
  } finally {
    await server.stop();
  }
});

test("serves liveness during initial discovery and exposes degraded readiness", { timeout: 2_000 }, async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const hanging = {
    id: "hanging",
    discover({ signal }) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        active -= 1;
        resolve([]);
      }, { once: true }));
    },
  };
  const registry = new AgentRegistry([hanging], { adapterTimeoutMs: 500 });
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 5 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const liveness = await fetch(`${base}/health`);
    assert.equal(liveness.status, 200);
    assert.equal((await liveness.json()).live, true);

    const loading = await fetch(`${base}/ready`);
    assert.equal(loading.status, 503);
    assert.equal((await loading.json()).initialLoading, true);

    await registry.refresh();
    const readiness = await fetch(`${base}/ready`);
    const readyBody = await readiness.json();
    assert.equal(readiness.status, 200);
    assert.equal(readyBody.ready, true);
    assert.equal(readyBody.degraded, true);

    const adapters = await (await fetch(`${base}/v1/adapters`)).json();
    assert.equal(adapters.adapters[0].id, "hanging");
    assert.equal(adapters.adapters[0].status, "timeout");
    assert.equal(adapters.adapters[0].error.code, "discovery_timeout");

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(calls >= 1);
    assert.equal(maxActive, 1);
  } finally {
    await server.stop();
  }
});
