#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DECLARATION_BYTES = 1024 * 1024;
const DECLARATIONS = Object.freeze({
  stubs: "dist/esm/stubs.d.ts",
  agent: "dist/esm/agent.d.ts",
  run: "dist/esm/run.d.ts",
  options: "dist/esm/options.d.ts",
  messages: "dist/esm/messages.d.ts",
  store: "dist/esm/store/local-agent-store.d.ts",
});

export class CursorSdkProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "CursorSdkProbeError";
    this.code = code;
  }
}

export async function inspectCursorSdkPackage(packageDirectory, fsApi = { lstat, readFile, realpath }) {
  const root = await trustedRoot(packageDirectory, fsApi);
  const manifest = parseManifest(await readTrusted(root, "package.json", fsApi));
  const declarations = {};
  for (const [name, path] of Object.entries(DECLARATIONS)) {
    declarations[name] = await readTrusted(root, path, fsApi);
  }

  const surface = {
    agents: matches(declarations.stubs, {
      create: /static create\(/,
      resume: /static resume\(/,
      list: /static list\(/,
      listRuns: /static listRuns\(/,
      getRun: /static getRun\(/,
      cancelRun: /static cancelRun\(/,
      messages: /static readonly messages/,
    }),
    runs: matches(declarations.run, {
      supports: /supports\(operation:/,
      stream: /stream\(\): AsyncGenerator/,
      conversation: /conversation\(\): Promise/,
      wait: /wait\(\): Promise/,
      cancel: /cancel\(\): Promise/,
      statusListener: /onDidChangeStatus/,
    }),
    runtimes: matches(declarations.agent, {
      localList: /runtime: "local"/,
      cloudList: /runtime: "cloud"/,
      cloudMetadata: /metadata\?: Record<string, string>/,
    }),
    controls: matches(declarations.options, {
      local: /local\?: LocalAgentOptions/,
      cloud: /cloud\?: CloudAgentOptions/,
      idempotencyKey: /idempotencyKey\?: string/,
      toolAllowlist: /tools\?: ToolName\[\]/,
      toolDenylist: /disallowedTools\?: ToolName\[\]/,
    }),
    events: matches(declarations.messages, {
      user: /type: "user"/,
      assistant: /type: "assistant"/,
      status: /type: "status"/,
      toolCall: /type: "tool_call"/,
      usage: /type: "usage"/,
    }),
    localStore: matches(declarations.store, {
      agents: /readonly agents: LocalAgentStoreAgents/,
      runs: /readonly runs: LocalAgentStoreRuns/,
      runEvents: /readonly runEvents: LocalAgentStoreRunEvents/,
      checkpoints: /readonly checkpoints: LocalAgentStoreCheckpoints/,
    }),
  };
  const missing = [];
  for (const [group, values] of Object.entries(surface)) {
    for (const [name, present] of Object.entries(values)) {
      if (!present) missing.push(`${group}.${name}`);
    }
  }
  return {
    schemaVersion: 1,
    package: {
      name: manifest.name,
      version: manifest.version,
      node: manifest.engines.node,
    },
    surface,
    complete: missing.length === 0,
    missing,
  };
}

function matches(source, patterns) {
  return Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [name, pattern.test(source)]));
}

async function trustedRoot(path, fsApi) {
  if (typeof path !== "string" || path.length === 0) throw new CursorSdkProbeError("cursor_sdk_package_invalid");
  const requested = resolve(path);
  let info;
  try { info = await fsApi.lstat(requested); }
  catch { throw new CursorSdkProbeError("cursor_sdk_package_unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CursorSdkProbeError("cursor_sdk_package_unsafe");
  return fsApi.realpath(requested);
}

async function readTrusted(root, relativePath, fsApi) {
  const requested = resolve(root, relativePath);
  if (!requested.startsWith(`${root}${sep}`)) throw new CursorSdkProbeError("cursor_sdk_package_unsafe");
  let info;
  try { info = await fsApi.lstat(requested); }
  catch { throw new CursorSdkProbeError("cursor_sdk_declaration_unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DECLARATION_BYTES) {
    throw new CursorSdkProbeError("cursor_sdk_declaration_unsafe");
  }
  const canonical = await fsApi.realpath(requested);
  if (!canonical.startsWith(`${root}${sep}`)) throw new CursorSdkProbeError("cursor_sdk_declaration_unsafe");
  return fsApi.readFile(canonical, "utf8");
}

function parseManifest(source) {
  let manifest;
  try { manifest = JSON.parse(source); }
  catch { throw new CursorSdkProbeError("cursor_sdk_manifest_invalid"); }
  if (manifest?.name !== "@cursor/sdk" || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || typeof manifest?.engines?.node !== "string") {
    throw new CursorSdkProbeError("cursor_sdk_manifest_invalid");
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectCursorSdkPackage(process.argv[2]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.complete) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? "cursor_sdk_probe_failed" })}\n`);
    process.exitCode = 1;
  }
}
