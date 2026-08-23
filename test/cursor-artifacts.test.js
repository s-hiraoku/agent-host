import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CursorArtifactError,
  cursorProfileScope,
  findCursorTranscriptCandidates,
  parseCursorTranscript,
  readCursorConversationRows,
  reconcileCursorTranscripts,
} from "../src/adapters/cursor-artifacts.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "22222222-2222-4222-8222-222222222222";
const CLOUD = "cloud-session-with-non-uuid-identifier";
const FIXTURES = new URL("../fixtures/cursor-desktop/", import.meta.url);

async function temporaryRoots(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-cursor-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataDirectory = join(root, "Cursor");
  const storage = join(userDataDirectory, "User", "globalStorage");
  const projectsDirectory = join(root, "projects");
  await mkdir(storage, { recursive: true });
  await mkdir(projectsDirectory, { recursive: true });
  return { root, userDataDirectory, storage, projectsDirectory };
}

async function copyTranscript(projectsDirectory, project, session, fixture, { finalNewline = true } = {}) {
  const directory = join(projectsDirectory, project, "agent-transcripts", session);
  await mkdir(directory, { recursive: true });
  let content = await readFile(new URL(fixture, FIXTURES), "utf8");
  if (!finalNewline) content = content.trimEnd();
  const path = join(directory, `${session}.jsonl`);
  await writeFile(path, content);
  return { path, size: Buffer.byteLength(content), projectKey: project };
}

async function createConversationDatabase(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
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
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
  `);
  insert.run("local", "", SESSION, "Synthetic recent title", 2_000, 0, "recent-root", null);
  insert.run("local", "", ARCHIVED, "Synthetic archived title", 1_000, 1, "archived-root", null);
  insert.run("cloud-cache", "scope", CLOUD, "Synthetic cloud title", 3_000, 0, null, "cloud-cache");
  return database;
}

test("reads only bounded local Cursor rows through a live WAL in read-only mode", async (t) => {
  const roots = await temporaryRoots(t);
  const writer = await createConversationDatabase(join(roots.storage, "conversation-search.db"));
  t.after(() => writer.close());

  const recent = await readCursorConversationRows({ userDataDirectory: roots.userDataDirectory, limit: 10 });
  assert.deepEqual(recent.map((row) => row.id), [SESSION]);
  assert.equal(recent[0].title, "Synthetic recent title");
  assert.equal(recent[0].archived, false);

  const history = await readCursorConversationRows({
    userDataDirectory: roots.userDataDirectory,
    includeArchived: true,
    limit: 10,
  });
  assert.deepEqual(history.map((row) => row.id), [SESSION, ARCHIVED]);
  assert.equal(history[1].archived, true);
  assert.equal(history.some((row) => row.id === CLOUD), false);
});

test("database validation rejects symlinks and sanitizes errors", async (t) => {
  const roots = await temporaryRoots(t);
  const real = join(roots.root, "outside.db");
  const writer = await createConversationDatabase(real);
  writer.close();
  await symlink(real, join(roots.storage, "conversation-search.db"));
  await assert.rejects(
    readCursorConversationRows({ userDataDirectory: roots.userDataDirectory }),
    (error) => error instanceof CursorArtifactError
      && error.code === "cursor_artifact_unsafe"
      && !error.message.includes(roots.root),
  );
});

test("canonical transcript comparison handles identical, prefix, divergent, partial, and corrupt streams", async (t) => {
  const roots = await temporaryRoots(t);
  const prefix = await copyTranscript(roots.projectsDirectory, "project-prefix", SESSION, "prefix.jsonl");
  const complete = await copyTranscript(roots.projectsDirectory, "project-complete", SESSION, "complete-success.jsonl");
  const divergent = await copyTranscript(roots.projectsDirectory, "project-divergent", SESSION, "divergent.jsonl");
  const partial = await copyTranscript(
    roots.projectsDirectory, "project-partial", SESSION, "partial.jsonl", { finalNewline: false },
  );
  const corrupt = await copyTranscript(roots.projectsDirectory, "project-corrupt", SESSION, "corrupt-middle.jsonl");

  const prefixParsed = await parseCursorTranscript(prefix);
  const completeParsed = await parseCursorTranscript(complete);
  const partialParsed = await parseCursorTranscript(partial);
  const corruptParsed = await parseCursorTranscript(corrupt);
  assert.equal(completeParsed.status, "idle");
  assert.equal(prefixParsed.status, "working");
  assert.equal(partialParsed.valid, true);
  assert.equal(partialParsed.partial, true);
  assert.equal(partialParsed.status, "unknown");
  assert.equal(corruptParsed.valid, false);

  const prefixResult = reconcileCursorTranscripts([
    { ...prefix, transcript: prefixParsed },
    { ...complete, transcript: completeParsed },
  ]);
  assert.equal(prefixResult.conflict, false);
  assert.equal(prefixResult.readable, true);
  assert.equal(prefixResult.status, "idle");

  const partialResult = reconcileCursorTranscripts([
    { ...complete, transcript: completeParsed },
    { ...partial, transcript: partialParsed },
  ]);
  assert.equal(partialResult.conflict, false);
  assert.equal(partialResult.readable, true);
  assert.equal(partialResult.status, "unknown");
  assert.equal(partialResult.partial, true);

  const divergentParsed = await parseCursorTranscript(divergent);
  const divergentResult = reconcileCursorTranscripts([
    { ...complete, transcript: completeParsed },
    { ...divergent, transcript: divergentParsed },
  ]);
  assert.equal(divergentResult.conflictKind, "divergent");
  assert.equal(divergentResult.readable, false);
  assert.equal(divergentResult.status, "unknown");

  const corruptResult = reconcileCursorTranscripts([{ ...corrupt, transcript: corruptParsed }]);
  assert.equal(corruptResult.conflictKind, "corrupt");
  assert.equal(corruptResult.readable, false);
});

test("canonical comparison ignores JSON whitespace and key order without ignoring tool records", async (t) => {
  const roots = await temporaryRoots(t);
  const firstPath = join(roots.root, "first.jsonl");
  const secondPath = join(roots.root, "second.jsonl");
  const first = '{"role":"assistant","message":{"content":[{"type":"tool","input":{"b":2,"a":1},"name":"fixture"}]}}\n';
  const second = '{ "message": { "content": [{"name":"fixture","input":{"a":1,"b":2},"type":"tool"}] }, "role":"assistant" }\n';
  await writeFile(firstPath, first);
  await writeFile(secondPath, second);
  const left = { path: firstPath, size: Buffer.byteLength(first), projectKey: "left" };
  const right = { path: secondPath, size: Buffer.byteLength(second), projectKey: "right" };
  const leftParsed = await parseCursorTranscript(left);
  const rightParsed = await parseCursorTranscript(right);
  assert.deepEqual(leftParsed.recordHashes, rightParsed.recordHashes);
  const result = reconcileCursorTranscripts([
    { ...left, transcript: leftParsed },
    { ...right, transcript: rightParsed },
  ]);
  assert.equal(result.conflict, false);
  assert.equal(result.omittedBlocks, 1);
});

test("bounded read exposes only user and assistant text", async (t) => {
  const roots = await temporaryRoots(t);
  const candidate = await copyTranscript(roots.projectsDirectory, "project-safe", SESSION, "complete-success.jsonl");
  const parsed = await parseCursorTranscript(candidate, {
    limits: { maxMessageChars: 12, maxTextChars: 24 },
  });
  const serialized = JSON.stringify(parsed.messages);
  assert.equal(serialized.includes("SYNTHETIC_TOOL_SECRET"), false);
  assert.equal(serialized.includes("synthetic_tool"), false);
  assert.deepEqual(parsed.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(parsed.omittedBlocks, 1);
  assert.equal(parsed.truncated, true);
});

test("transcript discovery accepts an owned root symlink but rejects nested symlinks and enforces bounds", async (t) => {
  const roots = await temporaryRoots(t);
  await copyTranscript(roots.projectsDirectory, "project-real", SESSION, "complete-success.jsonl");
  const rootLink = join(roots.root, "projects-link");
  await symlink(roots.projectsDirectory, rootLink);
  const found = await findCursorTranscriptCandidates({ projectsDirectory: rootLink, sessionIds: [SESSION] });
  assert.equal(found.bySession.get(SESSION).length, 1);

  const other = join(roots.root, "other-session");
  await mkdir(other);
  await writeFile(join(other, `${ARCHIVED}.jsonl`), "{}\n");
  const transcriptRoot = join(roots.projectsDirectory, "project-symlink", "agent-transcripts");
  await mkdir(transcriptRoot, { recursive: true });
  await symlink(other, join(transcriptRoot, ARCHIVED));
  const rejected = await findCursorTranscriptCandidates({ projectsDirectory: rootLink, sessionIds: [ARCHIVED] });
  assert.equal(rejected.bySession.get(ARCHIVED).length, 0);

  const bounded = await findCursorTranscriptCandidates({
    projectsDirectory: rootLink,
    sessionIds: [SESSION],
    limits: { maxProjects: 1 },
  });
  assert.equal(bounded.truncated, true);

  if (typeof process.getuid === "function") {
    await assert.rejects(
      findCursorTranscriptCandidates({ projectsDirectory: rootLink, sessionIds: [SESSION], uid: process.getuid() + 1 }),
      /safety validation failed/,
    );
  }
});

test("profile scope is stable and does not reveal the configured path", () => {
  const path = "/synthetic/private/Cursor Profile";
  const first = cursorProfileScope(path);
  assert.equal(first, cursorProfileScope(path));
  assert.notEqual(first, cursorProfileScope(`${path} 2`));
  assert.equal(first.includes("synthetic"), false);
});
