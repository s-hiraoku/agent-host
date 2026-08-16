import test from "node:test";
import assert from "node:assert/strict";
import { DemoAdapter } from "../src/adapters/demo.js";
import { createRuntimeAdapters } from "../src/runtime.js";

test("demo mode is opt-in and replaces live adapters", () => {
  assert.deepEqual(createRuntimeAdapters().map((adapter) => adapter.id), ["codex", "herdr", "process"]);
  assert.deepEqual(createRuntimeAdapters({ demoMode: true }).map((adapter) => adapter.id), ["demo"]);
  assert.deepEqual(createRuntimeAdapters({
    codexTransport: "control",
    codexSocket: "/tmp/codex-control.sock",
  }).map((adapter) => adapter.id), ["codex", "herdr", "process"]);
  assert.throws(
    () => createRuntimeAdapters({ codexTransport: "control" }),
    /AGENT_HOST_CODEX_SOCKET must be an absolute path/,
  );
  assert.throws(
    () => createRuntimeAdapters({ codexTransport: "control", codexSocket: "relative.sock" }),
    /AGENT_HOST_CODEX_SOCKET must be an absolute path/,
  );
  assert.deepEqual(createRuntimeAdapters({
    enabledAdapters: ["process"],
    codexTransport: "control",
  }).map((adapter) => adapter.id), ["process"]);
  assert.deepEqual(createRuntimeAdapters({
    enabledAdapters: ["cursor-desktop"],
    cursorUserDataDirectory: "/synthetic/Cursor",
    cursorProjectsDirectory: "/synthetic/.cursor/projects",
  }).map((adapter) => adapter.id), ["cursor-desktop"]);
  assert.throws(
    () => createRuntimeAdapters({ codexTransport: "websocket" }),
    /AGENT_HOST_CODEX_TRANSPORT must be owned or control/,
  );
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
  const prompt = await adapter.prompt(idle, "https://untrusted.example/private-owner/private-repository");
  assert.deepEqual(prompt.data.transition, { from: "idle", to: "working" });
  assert.equal(prompt.data.transitionNumber, 1);

  const workingIdle = (await adapter.discover()).find((agent) => agent.id === "demo:idle");
  assert.equal(
    workingIdle.repositoryContext.associations[0].repository.webUrl,
    "https://forge.example/example-labs/new-context",
  );
  assert.equal(JSON.stringify(workingIdle.repositoryContext).includes("untrusted.example"), false);
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
