import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "../src/core/registry.js";
import { DemoAdapter } from "../src/adapters/demo.js";
import { createAgentServer } from "../src/http/server.js";
import { runClientConformance } from "../conformance/client-suite.js";

const TOKEN = "demo-conformance-token";
const fixtureDirectory = new URL("../fixtures/client-conformance/", import.meta.url);
const statuses = new Set(["unknown", "idle", "working", "blocked", "done", "error"]);

test("demo HTTP and SSE API passes the reusable client conformance suite", async () => {
  const registry = new AgentRegistry([new DemoAdapter()]);
  const server = createAgentServer(registry, {
    host: "127.0.0.1",
    port: 0,
    refreshMs: 60_000,
    apiToken: TOKEN,
  });
  const address = await server.start();
  try {
    const report = await runClientConformance({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    assert.equal(report.snapshotAgentCount, 6);
    assert.ok(report.observedEvents.includes("agent.action"));
    assert.ok(report.observedEvents.includes("agent.updated"));
    assert.ok(report.observedEvents.includes("agent.repository-associations.changed"));
    assert.equal(report.repositoryAssociationCount, 1);
  } finally {
    await server.stop();
  }
});

test("client fixtures are versioned, sanitized, and schema-compatible", async () => {
  const files = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(files.sort(), [
    "action.json", "adapter-failure.json", "approval.json", "error.json",
    "event-reconnect.json", "large-list.json", "repository-associations.json", "snapshot.json",
  ]);
  const fixtures = [];
  for (const file of files) {
    const text = await readFile(new URL(file, fixtureDirectory), "utf8");
    const fixture = JSON.parse(text);
    assert.equal(fixture.fixtureVersion, 1, file);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|Bearer\s|api[_-]?token|session[_-]?content|@example\./i, file);
    fixtures.push(fixture);
  }
  assert.equal(new Set(fixtures.map((fixture) => fixture.scenario)).size, files.length);
  assert.deepEqual(fixtures.find((fixture) => fixture.scenario === "snapshot").expected.statuses.sort(), [...statuses].sort());
  assert.equal(fixtures.find((fixture) => fixture.scenario === "action").expected.transition.to, "working");
  assert.equal(fixtures.find((fixture) => fixture.scenario === "error").expected.code, "agent_not_found");
  assert.equal(fixtures.find((fixture) => fixture.scenario === "approval").pendingApproval.approvalId, "demo-approval-1");
  assert.equal(fixtures.find((fixture) => fixture.scenario === "adapter-failure").response.adapters[0].status, "error");
  assert.match(fixtures.find((fixture) => fixture.scenario === "event-reconnect").reconnection.clientRule, /replace the local snapshot/);
  const repositories = fixtures.find((fixture) => fixture.scenario === "repository-associations");
  assert.equal(repositories.cases.zero.response.associations.length, 0);
  assert.equal(repositories.cases.one.associationCount, 1);
  assert.equal(repositories.cases.multiplePrivateCandidate.associationCount, 2);
  assert.equal(repositories.cases.stale.freshness, "stale");
  assert.equal(repositories.cases.partial.complete, false);
  assert.match(repositories.changedAssociation.reconnectRule, /refetch unconditionally/);

  const large = JSON.parse(await readFile(fileURLToPath(new URL("large-list.json", fixtureDirectory)), "utf8"));
  assert.equal(large.agents.length, 1_000);
  assert.equal(new Set(large.agents.map((agent) => agent.id)).size, 1_000);
  for (const agent of large.agents) {
    assert.ok(statuses.has(agent.status));
    assert.equal(agent.provider, "demo");
    assert.equal("cwd" in agent, false);
    assert.equal("metadata" in agent, false);
  }
});
