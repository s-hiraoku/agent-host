import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { AgentEventBus } from "../src/core/event-bus.js";
import { createAgentServer } from "../src/http/server.js";

test("server shutdown closes active SSE clients before registry cleanup", { timeout: 2000 }, async () => {
  let closeCalls = 0;
  const registry = {
    events: new AgentEventBus(),
    async refresh() { return []; },
    async close() { closeCalls += 1; },
  };
  const server = createAgentServer(registry, { host: "127.0.0.1", port: 0, refreshMs: 60_000 });
  const address = await server.start();

  let response;
  const request = get({ host: "127.0.0.1", port: address.port, path: "/v1/events" });
  await new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (res) => {
      response = res;
      res.once("data", resolve);
    });
  });

  const ended = response.complete
    ? Promise.resolve()
    : new Promise((resolve) => response.once("end", resolve));
  await server.stop();
  await ended;
  assert.equal(closeCalls, 1);
  assert.equal(response.complete, true);
});
