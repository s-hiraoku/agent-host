import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { AgentEventBus } from "../src/core/event-bus.js";
import { AgentRegistry } from "../src/core/registry.js";
import { createAgentServer } from "../src/http/server.js";
import { OperationsContext } from "../src/operations/context.js";

const API_TOKEN = "test-api-token";
const AUTHORIZATION = { authorization: `Bearer ${API_TOKEN}` };

test("server shutdown closes active SSE clients before registry cleanup", { timeout: 2000 }, async () => {
  let closeCalls = 0;
  const registry = {
    revision: 0,
    events: new AgentEventBus(),
    async refresh() { return []; },
    async close() { closeCalls += 1; },
  };
  const operations = new OperationsContext();
  const server = createAgentServer(registry, {
    host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: API_TOKEN, operations,
  });
  const address = await server.start();

  let response;
  let ready;
  const request = get({
    host: "127.0.0.1",
    port: address.port,
    path: "/v1/events",
    headers: { ...AUTHORIZATION, "last-event-id": "42" },
  });
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
  assert.match(ready, /id: 0/);
  assert.match(ready, /"apiVersion":"1"/);
  assert.match(ready, /"revision":0/);
  assert.match(ready, /"sequence":0/);
  const connectedMetrics = operations.metrics.snapshot();
  assert.equal(connectedMetrics.gauges.find((entry) => entry.name === "event_subscribers").value, 1);
  assert.equal(connectedMetrics.counters.find((entry) => entry.name === "sse_reconnects").value, 1);

  const eventData = new Promise((resolve) => response.once("data", resolve));
  registry.events.emit({
    type: "agent.updated",
    snapshotRevision: 1,
    agent: { id: "fixture:1", capabilities: {}, metadata: { secret: "must not leave the host" } },
  });
  const event = await eventData;
  assert.match(event, /event: agent.updated/);
  assert.match(event, /id: 1/);
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
  assert.equal(operations.metrics.snapshot().gauges.find((entry) => entry.name === "event_subscribers").value, 0);
});

test("server bounds registry cleanup by the shutdown grace period", { timeout: 2_000 }, async () => {
  const registry = {
    revision: 0,
    events: new AgentEventBus(),
    async refresh() { return []; },
    async close() { return new Promise(() => {}); },
  };
  const server = createAgentServer(registry, {
    host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: API_TOKEN, shutdownGraceMs: 5,
  });
  await server.start();

  const began = Date.now();
  await server.stop();
  assert.ok(Date.now() - began < 1_000);
});

test("server bounds action queues and finishes shutdown with an active action", { timeout: 5_000 }, async () => {
  let actionStarted;
  const started = new Promise((resolve) => { actionStarted = resolve; });
  const adapter = {
    id: "shutdown-fixture",
    async discover() {
      return [{
        id: "shutdown:1", provider: "fixture", source: "shutdown-fixture", name: "shutdown",
        status: "idle", capabilities: { prompt: true },
      }];
    },
    async prompt() {
      actionStarted();
      return new Promise(() => {});
    },
  };
  const registry = new AgentRegistry([adapter]);
  const server = createAgentServer(registry, {
    host: "127.0.0.1",
    port: 0,
    refreshMs: 60_000,
    apiToken: API_TOKEN,
    maxActionsPerAgent: 1,
    shutdownGraceMs: 5,
  });
  const address = await server.start();
  await registry.refresh();
  const url = `http://127.0.0.1:${address.port}/v1/agents/shutdown%3A1/prompt`;
  const first = fetch(url, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "shutdown-active-1" },
    body: JSON.stringify({ text: "private" }),
  }).catch((error) => error);
  await started;

  const overflow = await fetch(url, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "shutdown-active-2" },
    body: JSON.stringify({ text: "private" }),
  });
  assert.equal(overflow.status, 429);
  assert.equal(overflow.headers.get("retry-after"), "1");
  assert.equal((await overflow.json()).error.code, "queue_full");

  const began = Date.now();
  await server.stop();
  assert.ok(Date.now() - began < 2_000);
  await first;
  assert.equal(registry.closed, true);
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
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: API_TOKEN });
  const address = await server.start();
  await registry.refresh();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const firstResponse = await fetch(`${base}/v1/agents?provider=codex&limit=1`, { headers: AUTHORIZATION });
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
      { headers: AUTHORIZATION },
    )).json();
    assert.equal(second.agents[0].id, "fixture:gamma");
    assert.equal(second.page.nextCursor, undefined);

    const filtered = await (await fetch(`${base}/v1/agents?status=idle&cwd=WORK&q=beta`, { headers: AUTHORIZATION })).json();
    assert.deepEqual(filtered.agents.map((agent) => agent.id), ["fixture:beta"]);

    const cwdPage = await (await fetch(`${base}/v1/agents?cwd=%2FWORK&limit=1`, { headers: AUTHORIZATION })).json();
    const cwdNext = await fetch(
      `${base}/v1/agents?cwd=%2Fwork&limit=1&cursor=${encodeURIComponent(cwdPage.page.nextCursor)}`,
      { headers: AUTHORIZATION },
    );
    assert.equal(cwdNext.status, 200);
    assert.equal((await cwdNext.json()).agents.length, 1);

    const detail = await (await fetch(`${base}/v1/agents/${encodeURIComponent("fixture:alpha")}`, { headers: AUTHORIZATION })).json();
    assert.equal(detail.agent.sessionId, "session-alpha");
    assert.equal(detail.agent.pendingApprovals[0].approvalId, "approval-1");
    assert.equal("metadata" in detail.agent, false);
    assert.equal(JSON.stringify(detail).includes("secretProviderPayload"), false);

    const invalidLimitResponse = await fetch(`${base}/v1/agents?limit=0`, { headers: AUTHORIZATION });
    assert.equal(invalidLimitResponse.status, 400);
    assert.equal((await invalidLimitResponse.json()).error.code, "invalid_limit");

    const missingResponse = await fetch(`${base}/v1/agents/missing`, { headers: AUTHORIZATION });
    assert.equal(missingResponse.status, 404);
    assert.equal((await missingResponse.json()).error.code, "agent_not_found");

    const actionResponse = await fetch(`${base}/v1/agents/missing/prompt`, {
      method: "POST",
      headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "missing-agent-0001" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(actionResponse.status, 404);
    assert.equal((await actionResponse.json()).error.code, "agent_not_found");

    const successResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "success-prompt-0001" },
      body: JSON.stringify({ text: "hello" }),
    });
    const success = await successResponse.json();
    assert.equal(successResponse.status, 200);
    assert.deepEqual(success, {
      apiVersion: "1",
      result: { ok: true, agentId: "fixture:alpha", action: "prompt", data: "hello", replayed: false },
    });

    suffix = " changed";
    await fetch(`${base}/v1/refresh`, { method: "POST", headers: AUTHORIZATION });
    const staleResponse = await fetch(
      `${base}/v1/agents?provider=codex&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
      { headers: AUTHORIZATION },
    );
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).error.code, "stale_cursor");

    const invalidJsonResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "invalid-json-0001" },
      body: "{",
    });
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal((await invalidJsonResponse.json()).error.code, "invalid_json");

    const malformedIdResponse = await fetch(`${base}/v1/agents/%ZZ`, { headers: AUTHORIZATION });
    assert.equal(malformedIdResponse.status, 400);
    assert.equal((await malformedIdResponse.json()).error.code, "invalid_agent_id");

    const oversizedResponse = await fetch(`${base}/v1/agents/fixture%3Aalpha/prompt`, {
      method: "POST",
      headers: { ...AUTHORIZATION, "content-type": "application/json", "idempotency-key": "oversized-body-0001" },
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
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: API_TOKEN });
  const address = await server.start();
  await registry.refresh();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agents`, { headers: AUTHORIZATION });
    const body = await response.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.agents.length, 50);
    assert.equal(parsed.page.total, 1_000);
    assert.ok(parsed.page.nextCursor);
    assert.ok(Buffer.byteLength(body) < 100_000, `response was ${Buffer.byteLength(body)} bytes`);
    assert.equal(body.includes(largeMetadata), false);

    const maximumResponse = await fetch(`http://127.0.0.1:${address.port}/v1/agents?limit=200`, { headers: AUTHORIZATION });
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

test("reduces a recorded 1,116-agent environment to a useful default view", async () => {
  const capability = { prompt: false, sendKeys: false, approve: false, reject: false, interrupt: false, focus: false, read: false };
  const codexAgents = Array.from({ length: 1_000 }, (_, index) => ({
    id: `codex:history-${index}`,
    provider: "codex",
    source: "codex-fixture",
    name: `Codex ${index}`,
    status: index < 2 ? "working" : "unknown",
    capabilities: capability,
    lastActivityAt: new Date(Date.UTC(2026, 7, index < 10 ? 9 : 1)).toISOString(),
    discovery: { kind: "native", confidence: "high", visibility: index < 2 ? "active" : index < 10 ? "recent" : "historical" },
  }));
  const codex = {
    id: "codex-fixture",
    async discover() { return codexAgents.slice(0, 10); },
    async discoverHistory() { return codexAgents; },
  };
  const processAdapter = {
    id: "process-fixture",
    async discover() {
      return Array.from({ length: 108 }, (_, index) => ({
        id: `process:fixture-${index}`,
        provider: "fixture",
        source: "process-fixture",
        name: `Process ${index}`,
        status: "unknown",
        capabilities: capability,
        discovery: { kind: "process", confidence: index < 8 ? "high" : "low", visibility: index < 8 ? "active" : "raw" },
      }));
    },
  };
  let herdrSuffix = "";
  const herdr = {
    id: "herdr-fixture",
    async discover() {
      return Array.from({ length: 8 }, (_, index) => ({
        id: `herdr:fixture-${index}`, provider: "fixture", source: "herdr-fixture", name: `Herdr ${index}${herdrSuffix}`,
        status: "idle", capabilities: capability, discovery: { kind: "native", confidence: "high", visibility: "active" },
      }));
    },
  };
  const registry = new AgentRegistry([codex, processAdapter, herdr]);
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000, apiToken: API_TOKEN });
  const address = await server.start();
  await registry.refresh();
  const base = `http://127.0.0.1:${address.port}/v1/agents`;

  try {
    const defaultText = await (await fetch(`${base}?limit=200`, { headers: AUTHORIZATION })).text();
    const defaultView = JSON.parse(defaultText);
    assert.equal(defaultView.page.total, 26);
    assert.equal(defaultView.agents[0].status, "working");

    const historical = await (await fetch(`${base}?view=historical&limit=200`, { headers: AUTHORIZATION })).json();
    assert.equal(historical.page.total, 990);
    const historicalDetail = await fetch(`${base}/codex%3Ahistory-10`, { headers: AUTHORIZATION });
    assert.equal(historicalDetail.status, 200);
    herdrSuffix = " changed";
    await registry.refresh();
    const nextHistoryPage = await fetch(
      `${base}?view=historical&limit=200&cursor=${encodeURIComponent(historical.page.nextCursor)}`,
      { headers: AUTHORIZATION },
    );
    assert.equal(nextHistoryPage.status, 200);

    const rawText = await (await fetch(`${base}?view=raw&limit=200`, { headers: AUTHORIZATION })).text();
    const raw = JSON.parse(rawText);
    assert.equal(raw.page.total, 1_116);
    assert.ok(Buffer.byteLength(defaultText) < Buffer.byteLength(rawText));
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
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 5, apiToken: API_TOKEN });
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

    const adapters = await (await fetch(`${base}/v1/adapters`, { headers: AUTHORIZATION })).json();
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
