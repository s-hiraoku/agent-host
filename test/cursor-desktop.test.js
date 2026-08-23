import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorDesktopAdapter } from "../src/adapters/cursor-desktop.js";
import { cursorProfileScope } from "../src/adapters/cursor-artifacts.js";
import { agentSummary } from "../src/core/contracts.js";
import { AgentRegistry } from "../src/core/registry.js";

const RECENT = "33333333-3333-4333-8333-333333333333";
const ARCHIVED = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-08-16T00:00:00.000Z");
const FIXTURES = new URL("../fixtures/cursor-desktop/", import.meta.url);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-cursor-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataDirectory = join(root, "Cursor");
  const storage = join(userDataDirectory, "User", "globalStorage");
  const projectsDirectory = join(root, "projects");
  await mkdir(storage, { recursive: true });
  await mkdir(projectsDirectory, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(storage, "conversation-search.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversations (
      fts_rowid INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      branches TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      is_archived INTEGER NOT NULL,
      root_fingerprint TEXT,
      cache_fingerprint TEXT
    );
  `);
  const insert = database.prepare(`
    INSERT INTO conversations
      (source, scope, id, title, branches, updated_at, is_archived, root_fingerprint, cache_fingerprint)
    VALUES ('local', '', ?, ?, '', ?, ?, ?, NULL)
  `);
  insert.run(RECENT, "Synthetic Cursor task", NOW - 1_000, 0, "recent-root");
  insert.run(ARCHIVED, "Synthetic archived task", NOW - 30 * 24 * 60 * 60_000, 1, "archived-root");
  t.after(() => database.close());
  await installTranscript(projectsDirectory, "Volumes-Synthetic-example-repository", RECENT, "complete-success.jsonl");
  await installTranscript(projectsDirectory, "Volumes-Synthetic-archived", ARCHIVED, "divergent.jsonl");
  return {
    root,
    userDataDirectory,
    projectsDirectory,
    appFocus: {
      available: async () => false,
      activate: async () => {
        throw new Error("focus should not run unless a test enables it");
      },
    },
  };
}

async function installTranscript(projectsDirectory, project, session, fixture) {
  const directory = join(projectsDirectory, project, "agent-transcripts", session);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${session}.jsonl`), await readFile(new URL(fixture, FIXTURES)));
}

test("Cursor desktop adapter is observation-only with stable IDs and conservative history", async (t) => {
  const roots = await setup(t);
  const adapter = new CursorDesktopAdapter({ ...roots, now: () => NOW });
  const recent = await adapter.discover();
  assert.equal(recent.length, 1);
  const agent = recent[0];
  assert.equal(agent.id, `cursor-desktop:${cursorProfileScope(roots.userDataDirectory)}:${RECENT}`);
  assert.equal(agent.provider, "cursor");
  assert.equal(agent.name, "Synthetic Cursor task");
  assert.equal(agent.status, "idle");
  assert.deepEqual(agent.capabilities, {
    prompt: false,
    sendKeys: false,
    approve: false,
    reject: false,
    interrupt: false,
    focus: false,
    read: true,
  });
  assert.equal(agent.discovery.visibility, "recent");
  assert.equal(agent.cwd, undefined);
  assert.deepEqual(agentSummary(agent).workspaceCandidate, {
    id: agent.workspaceCandidate.id,
    name: "Volumes-Synthetic-example-repository",
    confidence: "low",
  });
  assert.equal("metadata" in agentSummary(agent), false);

  const history = await adapter.discoverHistory();
  assert.equal(history.length, 2);
  const archived = history.find((candidate) => candidate.sessionId === ARCHIVED);
  assert.equal(archived.discovery.visibility, "historical");
  assert.equal(archived.status, "error");
});

test("Cursor desktop adapter reports a valid unfinished transcript as working", async (t) => {
  const roots = await setup(t);
  await installTranscript(
    roots.projectsDirectory,
    "Volumes-Synthetic-example-repository",
    RECENT,
    "prefix.jsonl",
  );
  const adapter = new CursorDesktopAdapter({ ...roots, now: () => NOW });
  const [agent] = await adapter.discover();
  assert.equal(agent.status, "working");
});

test("Cursor read returns bounded text only and rechecks conflicts after discovery", async (t) => {
  const roots = await setup(t);
  const adapter = new CursorDesktopAdapter({ ...roots, now: () => NOW });
  const agent = (await adapter.discover())[0];
  const first = await adapter.read(agent);
  assert.equal(first.ok, true);
  assert.deepEqual(first.data.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(first.data.omittedBlockCount, 1);
  assert.equal(JSON.stringify(first).includes("SYNTHETIC_TOOL_SECRET"), false);

  await installTranscript(roots.projectsDirectory, "Volumes-Synthetic-conflicting-copy", RECENT, "divergent.jsonl");
  const afterConflict = await adapter.read(agent);
  assert.deepEqual(afterConflict, {
    ok: false,
    code: "cursor_transcript_conflict",
    agentId: agent.id,
    action: "read",
    message: "Cursor transcript artifacts conflict",
  });
  const rediscovered = (await adapter.discover())[0];
  assert.equal(rediscovered.status, "unknown");
  assert.equal(rediscovered.capabilities.read, false);
  assert.equal(rediscovered.metadata.cursorDesktop.conflictKind, "divergent");
});

test("Cursor discovery and read fail closed when duplicate scanning is truncated", async (t) => {
  const roots = await setup(t);
  const adapter = new CursorDesktopAdapter({
    ...roots,
    now: () => NOW,
    findTranscripts: async () => ({
      bySession: new Map([[RECENT, []]]),
      truncated: true,
      unsafeEntries: 0,
    }),
    inspectTranscripts: async () => new Map([[
      RECENT,
      {
        status: "idle",
        readable: true,
        conflict: false,
        partial: false,
        transcriptCount: 1,
        messages: [{ role: "assistant", text: "Synthetic response" }],
        messageCount: 1,
        omittedBlocks: 0,
        truncated: false,
      },
    ]]),
  });

  const agent = (await adapter.discover())[0];
  assert.equal(agent.status, "unknown");
  assert.equal(agent.capabilities.read, false);
  assert.equal(agent.discovery.confidence, "low");
  assert.equal(agent.metadata.cursorDesktop.conflict, true);
  assert.equal(agent.metadata.cursorDesktop.conflictKind, "scan-truncated");
  assert.deepEqual(await adapter.read(agent), {
    ok: false,
    code: "cursor_transcript_conflict",
    agentId: agent.id,
    action: "read",
    message: "Cursor transcript artifacts conflict",
  });
});

test("Cursor desktop focus is app-level only and stays off until the application is present", async (t) => {
  const roots = await setup(t);
  const activations = [];
  const adapter = new CursorDesktopAdapter({
    ...roots,
    now: () => NOW,
    appFocus: {
      available: async (app) => app.appName === "Cursor",
      activate: async (app) => {
        activations.push(app.appName);
        return { ok: true };
      },
    },
  });
  const agent = (await adapter.discover())[0];
  assert.equal(agent.capabilities.focus, true);
  assert.equal(agent.capabilities.prompt, false);
  assert.equal(agent.capabilities.interrupt, false);
  assert.deepEqual(await adapter.focus(agent), { ok: true, agentId: agent.id, action: "focus" });
  assert.deepEqual(activations, ["Cursor"]);

  const missing = new CursorDesktopAdapter({
    ...roots,
    now: () => NOW,
    appFocus: {
      available: async () => false,
      activate: async () => ({ ok: false, code: "desktop_focus_unavailable" }),
    },
  });
  const hidden = (await missing.discover())[0];
  assert.equal(hidden.capabilities.focus, false);
  assert.deepEqual(await missing.focus(hidden), {
    ok: false,
    code: "capability_not_available",
    agentId: hidden.id,
    action: "focus",
    message: "capability focus is not available",
  });
});

test("Cursor desktop focus failures stay path-free and do not imply session targeting", async (t) => {
  const roots = await setup(t);
  const adapter = new CursorDesktopAdapter({
    ...roots,
    now: () => NOW,
    appFocus: {
      available: async () => true,
      activate: async () => ({ ok: false, code: "desktop_focus_failed" }),
    },
  });
  const agent = (await adapter.discover())[0];
  const result = await adapter.focus(agent);
  assert.deepEqual(result, {
    ok: false,
    code: "desktop_focus_failed",
    agentId: agent.id,
    action: "focus",
    message: "Cursor application could not be brought to the front",
  });
  assert.equal(JSON.stringify(result).includes(roots.root), false);
});

test("Cursor stale records disable read and all mutation capabilities", async (t) => {
  const roots = await setup(t);
  const adapter = new CursorDesktopAdapter({ ...roots, now: () => NOW });
  const agent = (await adapter.discover())[0];
  const stale = adapter.markStale(agent);
  assert.equal(stale.status, "unknown");
  assert.equal(stale.discovery.confidence, "low");
  assert.equal(Object.values(stale.capabilities).some(Boolean), false);
});

test("Cursor database failures do not leak artifact paths or contents through health logs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-SYNTHETIC_PRIVATE_PATH-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataDirectory = join(root, "Cursor");
  const storage = join(userDataDirectory, "User", "globalStorage");
  const projectsDirectory = join(root, "projects");
  await mkdir(storage, { recursive: true });
  await mkdir(projectsDirectory, { recursive: true });
  await writeFile(join(storage, "conversation-search.db"), "SYNTHETIC_DATABASE_SECRET");
  const logs = [];
  const registry = new AgentRegistry([
    new CursorDesktopAdapter({ userDataDirectory, projectsDirectory }),
  ], {
    operations: {
      logger: { log: (...entry) => logs.push(entry) },
      metrics: { increment() {}, observe() {} },
    },
  });
  t.after(() => registry.close());
  await registry.refresh();
  const health = registry.adapterHealth()[0];
  assert.equal(health.status, "error");
  assert.equal(health.error.code, "cursor_database_unavailable");
  const serialized = JSON.stringify({ health, logs });
  assert.equal(serialized.includes("SYNTHETIC_DATABASE_SECRET"), false);
  assert.equal(serialized.includes("SYNTHETIC_PRIVATE_PATH"), false);
  assert.equal(serialized.includes(root), false);
});
