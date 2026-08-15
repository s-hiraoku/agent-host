import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures", "client-conformance");

export async function loadClientConformanceFixtures() {
  const names = [
    "snapshot", "action", "error", "approval", "adapter-failure", "event-reconnect", "repository-associations",
  ];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    JSON.parse(await readFile(join(fixtureDirectory, `${name}.json`), "utf8")),
  ])));
}

export async function runClientConformance({ baseUrl, token, fetchImpl = fetch }) {
  const fixtures = await loadClientConformanceFixtures();
  const headers = { authorization: `Bearer ${token}`, connection: "close" };
  const refresh = await fetchImpl(`${baseUrl}/v1/refresh`, { method: "POST", headers });
  assert.equal(refresh.status, 200, "demo refresh must succeed");

  const snapshotResponse = await fetchImpl(`${baseUrl}${fixtures.snapshot.request.path}`, { headers });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshot.apiVersion, fixtures.snapshot.expected.apiVersion);
  assert.equal(snapshot.agents.length, fixtures.snapshot.expected.agentCount);
  assert.deepEqual(
    [...new Set(snapshot.agents.map((agent) => agent.status))].sort(),
    [...fixtures.snapshot.expected.statuses].sort(),
  );
  assert.ok(snapshot.agents.every((agent) => agent.provider === fixtures.snapshot.expected.provider));

  const repositoryFixture = fixtures["repository-associations"];
  const capabilitiesResponse = await fetchImpl(`${baseUrl}${repositoryFixture.capability.path}`, { headers });
  const capabilities = await capabilitiesResponse.json();
  const repositoryCapability = capabilities.capabilities[repositoryFixture.capability.name];
  assert.equal(capabilitiesResponse.status, 200);
  assert.ok(repositoryCapability.versions.includes(repositoryFixture.capability.version));
  assert.equal(repositoryCapability.maxItems, repositoryFixture.capability.maxItems);
  const zeroAssociationResponse = await fetchImpl(
    `${baseUrl}${repositoryPath(repositoryFixture, repositoryFixture.cases.zero.agentId)}`,
    { headers },
  );
  const zeroAssociations = await zeroAssociationResponse.json();
  assert.equal(zeroAssociationResponse.status, 200);
  assert.equal(zeroAssociationResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(
    {
      state: zeroAssociations.state,
      freshness: zeroAssociations.freshness,
      complete: zeroAssociations.complete,
      associations: zeroAssociations.associations,
    },
    repositoryFixture.cases.zero.response,
  );
  const oneAssociations = await repositoryContext(
    baseUrl, headers, repositoryFixture, repositoryFixture.cases.one.agentId, fetchImpl,
  );
  assert.equal(oneAssociations.associations.length, repositoryFixture.cases.one.associationCount);
  assert.deepEqual(
    {
      forge: oneAssociations.associations[0].repository.forge,
      host: oneAssociations.associations[0].repository.host,
      coordinates: oneAssociations.associations[0].repository.coordinates,
      webUrl: oneAssociations.associations[0].repository.webUrl,
    },
    repositoryFixture.cases.one.repository,
  );
  const multipleAssociations = await repositoryContext(
    baseUrl, headers, repositoryFixture, repositoryFixture.cases.multiplePrivateCandidate.agentId, fetchImpl,
  );
  assert.equal(multipleAssociations.associations.length, repositoryFixture.cases.multiplePrivateCandidate.associationCount);
  assert.deepEqual(
    [...new Set(multipleAssociations.associations.map((item) => item.kind))].sort(),
    [...repositoryFixture.cases.multiplePrivateCandidate.expectedKinds].sort(),
  );
  assert.deepEqual(
    [...new Set(multipleAssociations.associations.map((item) => item.repository.visibility))].sort(),
    [...repositoryFixture.cases.multiplePrivateCandidate.expectedVisibilities].sort(),
  );
  for (const name of ["stale", "unavailable", "unsupported"]) {
    const expected = repositoryFixture.cases[name];
    const actual = await repositoryContext(baseUrl, headers, repositoryFixture, expected.agentId, fetchImpl);
    assert.equal(actual.state, expected.state);
    if (expected.freshness) assert.equal(actual.freshness, expected.freshness);
    if (expected.reason) assert.equal(actual.reason, expected.reason);
    if (expected.retryable !== undefined) assert.equal(actual.error.retryable, expected.retryable);
  }

  const approvalResponse = await fetchImpl(
    `${baseUrl}/v1/agents/${encodeURIComponent(fixtures.approval.agentId)}`,
    { headers },
  );
  const approval = await approvalResponse.json();
  assert.equal(approval.agent.status, fixtures.approval.status);
  assert.deepEqual(approval.agent.pendingApprovals[0], {
    ...approval.agent.pendingApprovals[0],
    ...fixtures.approval.pendingApproval,
  });

  const stream = await openEventStream(baseUrl, headers, fetchImpl);
  const observed = [];
  let lastSequence;
  let transitioned;
  try {
    const ready = await stream.next();
    assert.equal(ready.type, "ready");
    assert.equal(ready.data.apiVersion, "1");
    lastSequence = ready.data.sequence;

    const actionResponse = await fetchImpl(`${baseUrl}${fixtures.action.request.path}`, {
      method: fixtures.action.request.method,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "conformance-prompt-0001",
      },
      body: JSON.stringify(fixtures.action.request.body),
    });
    const action = await actionResponse.json();
    assert.equal(actionResponse.status, fixtures.action.expected.status);
    assert.equal(action.result.agentId, fixtures.action.expected.agentId);
    assert.equal(action.result.action, fixtures.action.expected.action);
    assert.deepEqual(action.result.data.transition, fixtures.action.expected.transition);

    while (!observed.includes("agent.action")) {
      const event = await stream.next();
      observed.push(event.type);
      lastSequence = event.data.sequence;
    }

    const transitionRefresh = await fetchImpl(`${baseUrl}/v1/refresh`, { method: "POST", headers });
    assert.equal(transitionRefresh.status, 200);
    while (!observed.includes("agent.updated")
      || !observed.includes(repositoryFixture.changedAssociation.event)) {
      const event = await stream.next();
      observed.push(event.type);
      lastSequence = event.data.sequence;
      if (event.type === repositoryFixture.changedAssociation.event) {
        assert.equal(event.data.agentId, repositoryFixture.changedAssociation.agentId);
        assert.equal("agent" in event.data, false);
        assert.equal(JSON.stringify(event.data).includes("forge.example"), false);
      }
    }
    for (const expectedEvent of fixtures.action.expected.events) assert.ok(observed.includes(expectedEvent));

    transitioned = await (await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(fixtures.action.expected.agentId)}`,
      { headers },
    )).json();
    assert.equal(transitioned.agent.status, fixtures.action.expected.transition.to);

    const changedAssociations = await (await fetchImpl(
      `${baseUrl}${repositoryPath(repositoryFixture, repositoryFixture.changedAssociation.agentId)}`,
      { headers },
    )).json();
    assert.equal(changedAssociations.associations.length, 1);

    const errorResponse = await fetchImpl(`${baseUrl}${fixtures.error.request.path}`, { headers });
    const error = await errorResponse.json();
    assert.equal(errorResponse.status, fixtures.error.expected.status);
    assert.equal(error.apiVersion, fixtures.error.expected.apiVersion);
    assert.equal(error.error.code, fixtures.error.expected.code);
  } finally {
    await stream.close();
  }

  const reconnected = await openEventStream(baseUrl, { ...headers, "last-event-id": String(lastSequence) }, fetchImpl);
  let reconnectReady;
  try {
    reconnectReady = await reconnected.next();
    assert.equal(reconnectReady.type, "ready");
    assert.ok(reconnectReady.data.sequence >= lastSequence);
    assert.equal(reconnectReady.data.revision, transitioned.revision);
    const refetched = await (await fetchImpl(
      `${baseUrl}${repositoryPath(repositoryFixture, repositoryFixture.changedAssociation.agentId)}`,
      { headers },
    )).json();
    assert.equal(refetched.associations.length, 1);
  } finally {
    await reconnected.close();
  }

  return {
    snapshotAgentCount: snapshot.agents.length,
    observedEvents: [...new Set(observed)],
    finalRevision: reconnectReady.data.revision,
    finalSequence: reconnectReady.data.sequence,
    repositoryAssociationCount: 1,
  };
}

function repositoryPath(fixture, agentId) {
  return fixture.request.pathTemplate.replace("{agentId}", encodeURIComponent(agentId));
}

async function repositoryContext(baseUrl, headers, fixture, agentId, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}${repositoryPath(fixture, agentId)}`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

async function openEventStream(baseUrl, headers, fetchImpl) {
  const controller = new AbortController();
  const response = await fetchImpl(`${baseUrl}/v1/events`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      const timer = setTimeout(() => controller.abort(new Error("timed out waiting for SSE event")), 2_000);
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const type = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (type && data) return { type, data: JSON.parse(data) };
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE stream ended before the expected event");
          buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}
