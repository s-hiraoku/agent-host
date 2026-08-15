import test from "node:test";
import assert from "node:assert/strict";
import { DemoAdapter } from "../src/adapters/demo.js";
import { eventView } from "../src/core/contracts.js";
import { AgentRegistry } from "../src/core/registry.js";
import {
  MAX_REPOSITORY_ASSOCIATIONS,
  normalizeRepositoryContext,
} from "../src/core/repository-associations.js";
import { createAgentServer } from "../src/http/server.js";

const TOKEN = "repository-association-test-token";
const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };

function association(name, overrides = {}) {
  return {
    kind: overrides.kind ?? "confirmed",
    repository: {
      forge: "github",
      host: "forge.example",
      coordinates: { kind: "named", owner: "example-labs", name },
      webUrl: `https://forge.example/example-labs/${name}`,
      ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
    },
    provenance: overrides.kind === "candidate"
      ? { source: "adapter-heuristic", confidence: "medium" }
      : { source: "adapter-authoritative", confidence: "high" },
    ...(overrides.kind === "candidate" ? { reason: "repository_match" } : {}),
    ...(overrides.checkout ? { checkout: overrides.checkout } : {}),
    ...(overrides.pullRequest ? { pullRequest: overrides.pullRequest } : {}),
  };
}

test("normalizes, bounds, deduplicates, and deterministically orders repository associations", () => {
  const entries = [association("zeta"), association("alpha"), association("alpha")];
  for (let index = 0; index < MAX_REPOSITORY_ASSOCIATIONS; index += 1) {
    entries.push(association(`bounded-${String(index).padStart(3, "0")}`));
  }
  entries.splice(2, 0, {
    ...association("candidate", { kind: "candidate" }),
    pullRequest: { number: 1 },
  });
  const context = normalizeRepositoryContext({ state: "ready", associations: entries });

  assert.equal(context.state, "ready");
  assert.equal(context.complete, false);
  assert.equal(context.associations.length, 100);
  assert.equal(context.error.rejectedCount, 1);
  assert.equal(context.error.overflowCount, 2);
  assert.deepEqual(
    context.associations.map((item) => item.repository.coordinates.name),
    [...context.associations.map((item) => item.repository.coordinates.name)].sort(),
  );
});

test("association ordering is deterministic across every normalized field", () => {
  const entries = [
    association("shared", { checkout: { branch: "main", worktree: { id: "worktree-z" } } }),
    association("shared", { checkout: { branch: "main", worktree: { id: "worktree-a" } } }),
    {
      ...association("shared", { kind: "candidate", checkout: { branch: "main" } }),
      reason: "branch_match",
    },
    association("shared", { kind: "candidate", checkout: { branch: "main" } }),
  ];
  const forward = normalizeRepositoryContext({ state: "ready", associations: entries });
  const reverse = normalizeRepositoryContext({ state: "ready", associations: [...entries].reverse() });

  assert.deepEqual(forward.associations, reverse.associations);
  assert.deepEqual(
    forward.associations.map((item) => item.checkout?.worktree?.id ?? item.reason),
    ["worktree-a", "worktree-z", "branch_match", "repository_match"],
  );
});

test("keeps unsupported, unavailable, stale, and partial semantics explicit without echoing invalid input", () => {
  assert.deepEqual(normalizeRepositoryContext(undefined), {
    state: "unsupported",
    reason: "adapter_not_supported",
  });
  assert.deepEqual(normalizeRepositoryContext({
    state: "unavailable",
    error: { code: "temporary_outage", retryable: true, message: "private repository name" },
  }), {
    state: "unavailable",
    error: { code: "repository_associations_unavailable", retryable: true },
  });
  const stale = normalizeRepositoryContext({
    state: "ready",
    freshness: "stale",
    observedAt: "2026-01-01T00:00:00.000Z",
    associations: [association("archive")],
  });
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.complete, true);

  const partial = normalizeRepositoryContext({
    state: "ready",
    observedAt: "not-a-timestamp",
    associations: [{ repository: { name: "private repository name" } }],
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.error.rejectedCount, 2);
  assert.equal(JSON.stringify(partial).includes("private repository name"), false);
});

test("rejects local worktree paths and unsafe repository URLs as partial input", () => {
  const context = normalizeRepositoryContext({
    state: "ready",
    associations: [
      association("path-leak", { checkout: { worktree: { id: "/workspace/private-repo" } } }),
      {
        ...association("url-leak"),
        repository: { ...association("url-leak").repository, webUrl: "https://user:secret@forge.example/private" },
      },
    ],
  });
  assert.equal(context.complete, false);
  assert.equal(context.associations.length, 0);
  assert.equal(context.error.rejectedCount, 2);
  assert.equal(JSON.stringify(context).includes("private-repo"), false);
  assert.equal(JSON.stringify(context).includes("secret"), false);
});

test("repository-only changes use a separate revision and a redacted SSE event", async () => {
  let branch = "feature/one";
  let present = true;
  const adapter = {
    id: "repository-fixture",
    async discover() {
      return present ? [{
        id: "fixture:repository",
        provider: "fixture",
        source: "repository-fixture",
        name: "Repository fixture",
        status: "idle",
        capabilities: {},
        cwd: "/workspace/private-project",
        repositoryContext: {
          state: "ready",
          associations: [association("private-project", {
            visibility: "private",
            checkout: { branch, worktree: { id: "worktree-1" } },
          })],
        },
      }] : [];
    },
  };
  const registry = new AgentRegistry([adapter]);
  const events = [];
  registry.events.subscribe((event) => events.push(event));
  await registry.refresh();
  const snapshotRevision = registry.revision;
  const repositoryRevision = registry.repositoryRevision;
  events.length = 0;

  branch = "feature/two";
  await registry.refresh();

  assert.equal(registry.revision, snapshotRevision);
  assert.equal(registry.repositoryRevision, repositoryRevision + 1);
  assert.equal(events.some((event) => event.type === "agent.updated"), false);
  assert.deepEqual(events.map((event) => event.type), ["agent.repository-associations.changed"]);
  assert.equal(JSON.stringify(events).includes("private-project"), false);

  const publicEvent = eventView({
    type: "agent.updated",
    agent: registry.get("fixture:repository"),
    sequence: 10,
  });
  assert.equal(JSON.stringify(publicEvent).includes("private-project"), false);
  assert.equal("cwd" in publicEvent.agent, false);

  events.length = 0;
  present = false;
  const repositoryRevisionBeforeRemoval = registry.repositoryRevision;
  await registry.refresh();
  assert.equal(registry.repositoryRevision, repositoryRevisionBeforeRemoval + 1);
  const removal = events.find((event) => event.type === "agent.repository-associations.changed");
  assert.equal(removal.removed, true);
  assert.equal("state" in removal, false);
});

test("historical repository changes advance the repository revision and emit events", async () => {
  let branch = "archive/one";
  let present = true;
  const adapter = {
    id: "historical-repository-fixture",
    async discover() { return []; },
    async discoverHistory() {
      return present ? [{
        id: "fixture:historical-repository",
        provider: "fixture",
        source: "historical-repository-fixture",
        name: "Historical repository fixture",
        status: "done",
        capabilities: {},
        repositoryContext: {
          state: "ready",
          associations: [association("private-archive", {
            visibility: "private",
            checkout: { branch, worktree: { id: "historical-worktree" } },
          })],
        },
      }] : [];
    },
  };
  const registry = new AgentRegistry([adapter], { historyTtlMs: 1 });
  const events = [];
  registry.events.subscribe((event) => events.push(event));

  await registry.listView("historical");
  const firstRevision = registry.repositoryRevision;
  assert.equal(registry.repositoryContext("fixture:historical-repository").context.associations[0].checkout.branch, "archive/one");
  events.length = 0;

  branch = "archive/two";
  await new Promise((resolve) => setTimeout(resolve, 5));
  await registry.listView("historical");
  assert.equal(registry.repositoryRevision, firstRevision + 1);
  assert.equal(registry.repositoryContext("fixture:historical-repository").revision, firstRevision + 1);
  assert.deepEqual(events.map((event) => event.type), ["agent.repository-associations.changed"]);
  assert.equal(events[0].agentId, "fixture:historical-repository");
  assert.equal(JSON.stringify(events).includes("private-archive"), false);

  events.length = 0;
  present = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await registry.listView("historical");
  assert.equal(registry.repositoryRevision, firstRevision + 2);
  assert.equal(events[0].removed, true);
  assert.equal(registry.repositoryContext("fixture:historical-repository"), null);
});

test("serves versioned, no-store repository association capabilities and demo contexts", async () => {
  const registry = new AgentRegistry([new DemoAdapter()]);
  const server = createAgentServer(registry, {
    host: "127.0.0.1",
    port: 0,
    refreshMs: 60_000,
    apiToken: TOKEN,
  });
  const address = await server.start();
  await registry.refresh();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/v1/capabilities`)).status, 401);
    assert.equal((await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:idle")}/repository-associations?version=1`,
    )).status, 401);
    const capabilitiesResponse = await fetch(`${base}/v1/capabilities`, { headers: AUTHORIZATION });
    const capabilities = await capabilitiesResponse.json();
    assert.equal(capabilitiesResponse.status, 200);
    assert.equal(capabilitiesResponse.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(capabilities.capabilities.repositoryAssociations.versions, ["1"]);
    assert.equal(capabilities.capabilities.repositoryAssociations.maxItems, 100);

    const zeroResponse = await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:idle")}/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    );
    const zero = await zeroResponse.json();
    assert.equal(zeroResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(zero.state, "ready");
    assert.deepEqual(zero.associations, []);

    const multiple = await (await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:blocked")}/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    )).json();
    assert.equal(multiple.associations.length, 2);
    assert.ok(multiple.associations.some((item) => item.repository.visibility === "private"));
    assert.ok(multiple.associations.some((item) => item.kind === "candidate"));

    const stale = await (await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:done")}/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    )).json();
    assert.equal(stale.freshness, "stale");

    const unavailable = await (await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:error")}/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    )).json();
    assert.equal(unavailable.state, "unavailable");
    const unsupported = await (await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:unknown")}/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    )).json();
    assert.equal(unsupported.state, "unsupported");

    const wrongVersion = await fetch(
      `${base}/v1/agents/${encodeURIComponent("demo:idle")}/repository-associations?version=2`,
      { headers: AUTHORIZATION },
    );
    assert.equal(wrongVersion.status, 406);
    assert.equal((await wrongVersion.json()).error.code, "unsupported_repository_association_version");

    const missing = await fetch(
      `${base}/v1/agents/missing/repository-associations?version=1`,
      { headers: AUTHORIZATION },
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "private, no-store");
  } finally {
    await server.stop();
  }
});
