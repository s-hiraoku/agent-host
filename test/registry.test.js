import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/core/registry.js";

const fake = {
  id: "fake",
  async discover() {
    const now = "2026-08-08T00:00:00.000Z";
    return [{ id: "fake:1", provider: "fake", source: "fake", name: "fake one", status: "idle",
      capabilities: { prompt: true, sendKeys: false, approve: false, reject: false, interrupt: false, focus: false, read: false },
      discoveredAt: now, updatedAt: now }];
  },
  async prompt(agent, text) { return { ok: true, agentId: agent.id, action: "prompt", data: text }; }
};

test("discovers and invokes capability-backed action", async () => {
  const registry = new AgentRegistry([fake]);
  await registry.refresh();
  assert.equal(registry.list().length, 1);
  const result = await registry.action("fake:1", "prompt", { text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.data, "hello");
});

test("rejects unsupported actions", async () => {
  const registry = new AgentRegistry([fake]);
  await registry.refresh();
  const result = await registry.action("fake:1", "approve");
  assert.equal(result.ok, false);
});
