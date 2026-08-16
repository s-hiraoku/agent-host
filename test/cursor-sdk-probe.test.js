import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CursorSdkProbeError,
  inspectCursorSdkPackage,
} from "../scripts/probe-cursor-sdk-package.mjs";

const DECLARATIONS = {
  "dist/esm/stubs.d.ts": `
    static create(); static resume(); static list(); static listRuns();
    static getRun(); static cancelRun(); static readonly messages;
  `,
  "dist/esm/agent.d.ts": `
    runtime: "local"; runtime: "cloud"; metadata?: Record<string, string>;
  `,
  "dist/esm/run.d.ts": `
    supports(operation: string); stream(): AsyncGenerator; conversation(): Promise;
    wait(): Promise; cancel(): Promise; onDidChangeStatus();
  `,
  "dist/esm/options.d.ts": `
    local?: LocalAgentOptions; cloud?: CloudAgentOptions; idempotencyKey?: string;
    tools?: ToolName[]; disallowedTools?: ToolName[];
  `,
  "dist/esm/messages.d.ts": `
    type: "user"; type: "assistant"; type: "status"; type: "tool_call"; type: "usage";
  `,
  "dist/esm/store/local-agent-store.d.ts": `
    readonly agents: LocalAgentStoreAgents; readonly runs: LocalAgentStoreRuns;
    readonly runEvents: LocalAgentStoreRunEvents; readonly checkpoints: LocalAgentStoreCheckpoints;
  `,
};

async function syntheticPackage(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-cursor-sdk-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@cursor/sdk",
    version: "1.0.28",
    engines: { node: ">=22.13" },
  }));
  for (const [path, contents] of Object.entries(DECLARATIONS)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

test("Cursor SDK package probe reports the allowlisted public contract", async (t) => {
  const report = await inspectCursorSdkPackage(await syntheticPackage(t));
  assert.deepEqual(report.package, {
    name: "@cursor/sdk",
    version: "1.0.28",
    node: ">=22.13",
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.complete, true);
  assert.deepEqual(report.missing, []);
  assert.equal(report.surface.agents.create, true);
  assert.equal(report.surface.runs.cancel, true);
  assert.equal(report.surface.localStore.runEvents, true);
});

test("Cursor SDK package probe fails closed on surface drift", async (t) => {
  const root = await syntheticPackage(t);
  await writeFile(join(root, "dist/esm/run.d.ts"), "stream(): AsyncGenerator;");
  const report = await inspectCursorSdkPackage(root);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missing, [
    "runs.supports",
    "runs.conversation",
    "runs.wait",
    "runs.cancel",
    "runs.statusListener",
  ]);
});

test("Cursor SDK package probe rejects linked declaration files", async (t) => {
  const root = await syntheticPackage(t);
  const declaration = join(root, "dist/esm/run.d.ts");
  await rm(declaration);
  await symlink(join(root, "dist/esm/stubs.d.ts"), declaration);
  await assert.rejects(
    inspectCursorSdkPackage(root),
    (error) => error instanceof CursorSdkProbeError && error.code === "cursor_sdk_declaration_unsafe",
  );
});
