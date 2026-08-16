import test from "node:test";
import assert from "node:assert/strict";
import { runCursorCompanionProbe } from "../spikes/cursor-companion/src/probe.js";

function fakeVscode(overrides = {}) {
  return {
    version: "1.128.0",
    env: { appName: "Cursor", appHost: "desktop", appRoot: "/Applications/Cursor.app", remoteName: undefined },
    cursor: undefined,
    commands: { getCommands: async () => ["workbench.action.chat.open", "cursor.agent.focusSession", "unrelated"] },
    extensions: { getExtension: () => undefined },
    ...overrides,
  };
}

test("companion probe reports an absent Cursor API without exposing host paths", async () => {
  const result = await runCursorCompanionProbe(fakeVscode(), () => new Date("2026-08-15T00:00:00Z"));
  assert.equal(result.recordedAt, "2026-08-15T00:00:00.000Z");
  assert.equal(result.cursorApi.present, false);
  assert.equal(result.host.appRootKind, "string");
  assert.equal("appRoot" in result.host, false);
  assert.deepEqual(result.commands.relevant, ["cursor.agent.focusSession"]);
});

test("companion probe captures proposal failures and skips provider registration", async () => {
  let acquireCalls = 0;
  let registerCalls = 0;
  const cursor = {
    get cursorAgentHostEnabled() {
      throw new Error("cursorAgentHost proposals are only available for built-in extensions");
    },
    acquireAgentHostRuntime() {
      acquireCalls += 1;
      throw Object.assign(new Error("proposal denied"), { code: "PROPOSED_API_DENIED" });
    },
    registerAgentHostProvider() { registerCalls += 1; },
    registerAgentHostRuntime() { registerCalls += 1; },
  };
  const result = await runCursorCompanionProbe(fakeVscode({ cursor }));
  assert.equal(result.cursorApi.present, true);
  assert.equal(result.cursorApi.checks.cursorAgentHostEnabled.ok, false);
  assert.match(result.cursorApi.checks.cursorAgentHostEnabled.error.message, /cursorAgentHost/);
  assert.equal(result.cursorApi.checks.cursorAgentHostEnabled.error.category, "builtin-only-proposal");
  assert.equal(result.cursorApi.checks.acquireAgentHostRuntime.error.code, "PROPOSED_API_DENIED");
  assert.equal(acquireCalls, 1);
  assert.equal(registerCalls, 0);
  assert.deepEqual(result.cursorApi.mutatingChecksSkipped, ["registerAgentHostProvider", "registerAgentHostRuntime"]);
});

test("companion probe summarizes a built-in extension without retaining exported values", async () => {
  const builtin = {
    isActive: false,
    extensionPath: "/Applications/Cursor.app/private/path",
    packageJSON: { enabledApiProposals: ["cursorAgentHost", "control"] },
    activate: async () => ({ listSessions() {}, secret: "not retained" }),
  };
  const result = await runCursorCompanionProbe(fakeVscode({
    extensions: { getExtension: () => builtin },
  }));
  assert.equal(result.builtinAgentHost.installed, true);
  assert.equal(result.builtinAgentHost.extensionPathKind, "string");
  assert.equal("extensionPath" in result.builtinAgentHost, false);
  assert.deepEqual(result.builtinAgentHost.declaredProposals, ["control", "cursorAgentHost"]);
  assert.deepEqual(result.builtinAgentHost.activation.exports, ["listSessions", "secret"]);
  assert.equal(JSON.stringify(result).includes("not retained"), false);
});
