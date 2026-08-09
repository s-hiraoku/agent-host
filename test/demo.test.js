import test from "node:test";
import assert from "node:assert/strict";
import { DemoAdapter } from "../src/adapters/demo.js";
import { createRuntimeAdapters } from "../src/runtime.js";

test("demo mode is opt-in and replaces live adapters", () => {
  assert.deepEqual(createRuntimeAdapters().map((adapter) => adapter.id), ["codex", "herdr", "process"]);
  assert.deepEqual(createRuntimeAdapters({ demoMode: true }).map((adapter) => adapter.id), ["demo"]);
});

test("demo adapter exposes every state and deterministic capability combinations", async () => {
  const adapter = new DemoAdapter();
  const agents = await adapter.discover();
  assert.deepEqual(
    agents.map((agent) => agent.status).sort(),
    ["unknown", "idle", "working", "blocked", "done", "error"].sort(),
  );
  assert.deepEqual(agents.find((agent) => agent.id === "demo:done").capabilities, {
    prompt: false, sendKeys: false, approve: false, reject: false, interrupt: false, focus: false, read: true,
  });
  assert.equal(agents.find((agent) => agent.id === "demo:working").capabilities.interrupt, true);
  assert.equal(agents.find((agent) => agent.id === "demo:blocked").pendingApprovals.length, 1);
});

test("demo adapter transitions prompts, interrupts, and approvals predictably", async () => {
  const adapter = new DemoAdapter();
  const initial = await adapter.discover();
  const idle = initial.find((agent) => agent.id === "demo:idle");
  const prompt = await adapter.prompt(idle, "hello");
  assert.deepEqual(prompt.data.transition, { from: "idle", to: "working" });
  assert.equal(prompt.data.transitionNumber, 1);

  const workingIdle = (await adapter.discover()).find((agent) => agent.id === "demo:idle");
  const interrupt = await adapter.interrupt(workingIdle);
  assert.deepEqual(interrupt.data.transition, { from: "working", to: "idle" });
  assert.equal(interrupt.data.transitionNumber, 2);
  const repeatedInterrupt = await adapter.interrupt(workingIdle);
  assert.equal(repeatedInterrupt.code, "capability_not_available");
  assert.equal(repeatedInterrupt.action, "interrupt");

  const blocked = initial.find((agent) => agent.id === "demo:blocked");
  const missing = await adapter.approve(blocked, { approvalId: "wrong" });
  assert.equal(missing.code, "approval_not_found");
  const approved = await adapter.approve(blocked, { approvalId: "demo-approval-1" });
  assert.deepEqual(approved.data.transition, { from: "blocked", to: "working" });
  assert.equal((await adapter.discover()).find((agent) => agent.id === "demo:blocked").pendingApprovals.length, 0);
});
