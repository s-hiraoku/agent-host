import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMITS = Object.freeze({
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxDatabaseSidecarBytes: 128 * 1024 * 1024,
  maxProjectEntries: 512,
  maxProjects: 128,
  maxProjectSessionChecks: 20_000,
  maxTranscriptCandidates: 512,
  maxTranscriptBytes: 8 * 1024 * 1024,
  maxTotalTranscriptBytes: 64 * 1024 * 1024,
  maxLines: 20_000,
  maxLineBytes: 1024 * 1024,
  maxCanonicalNodes: 20_000,
  maxMessages: 120,
  maxMessageChars: 8_192,
  maxTextChars: 64 * 1024,
  scanTimeoutMs: 2_000,
});

export class CursorArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CursorArtifactError";
    this.code = code;
  }
}

function artifactError(code) {
  const messages = {
    cursor_artifacts_not_found: "Cursor desktop artifacts were not found",
    cursor_artifact_unsafe: "Cursor desktop artifact safety validation failed",
    cursor_database_unavailable: "Cursor conversation database is unavailable",
    cursor_sqlite_unavailable: "The Node.js SQLite API required by the Cursor adapter is unavailable",
  };
  return new CursorArtifactError(code, messages[code] ?? "Cursor desktop artifacts are unavailable");
}

function limits(overrides = {}) {
  return { ...DEFAULT_LIMITS, ...overrides };
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function owned(info, uid) {
  return uid === undefined || info.uid === undefined || info.uid === uid;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function trustedRoot(path, { fsApi = fs, uid = currentUid() } = {}) {
  let configured;
  try { configured = await fsApi.lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") throw artifactError("cursor_artifacts_not_found");
    throw artifactError("cursor_artifact_unsafe");
  }
  if (!configured.isDirectory() && !configured.isSymbolicLink()) {
    throw artifactError("cursor_artifact_unsafe");
  }
  let real;
  let info;
  try {
    real = await fsApi.realpath(path);
    info = await fsApi.stat(real);
  } catch {
    throw artifactError("cursor_artifact_unsafe");
  }
  if (!info.isDirectory() || !owned(info, uid)) throw artifactError("cursor_artifact_unsafe");
  return real;
}

async function trustedChildDirectory(root, path, { fsApi = fs, uid = currentUid() } = {}) {
  let info;
  try { info = await fsApi.lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || !owned(info, uid)) return undefined;
  let real;
  try { real = await fsApi.realpath(path); }
  catch { return undefined; }
  return contained(root, real) ? real : undefined;
}

async function trustedFile(root, path, maxBytes, { fsApi = fs, uid = currentUid() } = {}) {
  let info;
  try { info = await fsApi.lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isFile() || !owned(info, uid)
    || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) return undefined;
  let real;
  try { real = await fsApi.realpath(path); }
  catch { return undefined; }
  return contained(root, real) ? { path: real, size: info.size } : undefined;
}

async function requiredDatabaseFile(root, path, maxBytes, options) {
  const file = await trustedFile(root, path, maxBytes, options);
  if (!file) throw artifactError("cursor_artifact_unsafe");
  return file;
}

export function cursorProfileScope(userDataDirectory) {
  const canonical = resolve(userDataDirectory).normalize("NFKC");
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

export async function readCursorConversationRows({
  userDataDirectory,
  includeArchived = false,
  limit = 100,
  fsApi = fs,
  uid = currentUid(),
  limits: limitOverrides,
  databaseFactory,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be from 1 to 1000");
  const bounded = limits(limitOverrides);
  let root;
  try { root = await trustedRoot(userDataDirectory, { fsApi, uid }); }
  catch (error) {
    if (error?.code === "cursor_artifacts_not_found") return [];
    throw error;
  }
  const user = await trustedChildDirectory(root, join(root, "User"), { fsApi, uid });
  const storage = user && await trustedChildDirectory(root, join(user, "globalStorage"), { fsApi, uid });
  if (!storage) return [];
  const databasePath = join(storage, "conversation-search.db");
  try { await fsApi.lstat(databasePath); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw artifactError("cursor_artifact_unsafe");
  }
  const database = await requiredDatabaseFile(root, databasePath, bounded.maxDatabaseBytes, { fsApi, uid });
  const sidecars = new Map();
  for (const suffix of ["-wal", "-shm"]) {
    let exists = true;
    try { await fsApi.lstat(`${databasePath}${suffix}`); }
    catch (error) {
      if (error?.code === "ENOENT") exists = false;
      else throw artifactError("cursor_artifact_unsafe");
    }
    sidecars.set(suffix, exists);
    if (exists) {
      await requiredDatabaseFile(
        root,
        `${databasePath}${suffix}`,
        bounded.maxDatabaseSidecarBytes,
        { fsApi, uid },
      );
    }
  }
  if (sidecars.get("-wal") && !sidecars.get("-shm")) throw artifactError("cursor_database_unavailable");

  let createDatabase = databaseFactory;
  if (!createDatabase) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      createDatabase = (path) => new DatabaseSync(path, { readOnly: true });
    } catch {
      throw artifactError("cursor_sqlite_unavailable");
    }
  }

  let connection;
  try {
    connection = createDatabase(database.path);
    connection.exec?.("PRAGMA query_only = ON; PRAGMA busy_timeout = 250;");
    const archivedClause = includeArchived ? "" : "AND is_archived = 0";
    const rows = connection.prepare(`
      SELECT id, title, updated_at, is_archived, root_fingerprint
      FROM conversations
      WHERE source = 'local' ${archivedClause}
      ORDER BY updated_at DESC, id
      LIMIT ?
    `).all(limit);
    return rows.flatMap((row) => normalizeConversationRow(row));
  } catch (error) {
    if (error instanceof CursorArtifactError) throw error;
    throw artifactError("cursor_database_unavailable");
  } finally {
    try { connection?.close?.(); } catch { /* read-only connection cleanup */ }
  }
}

function normalizeConversationRow(row) {
  const id = typeof row?.id === "string" ? row.id.toLowerCase() : "";
  const updatedAt = typeof row?.updated_at === "bigint" ? Number(row.updated_at) : row?.updated_at;
  if (!UUID.test(id) || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return [];
  const rawTitle = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
  if (!Number.isFinite(new Date(updatedAt).getTime())) return [];
  return [{
    id,
    title: rawTitle.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, "")
      .slice(0, 200) || `Cursor session ${id.slice(0, 8)}`,
    updatedAt,
    archived: row.is_archived === 1 || row.is_archived === 1n,
    rootFingerprint: typeof row.root_fingerprint === "string" ? row.root_fingerprint.slice(0, 256) : undefined,
  }];
}

export async function findCursorTranscriptCandidates({
  projectsDirectory,
  sessionIds,
  fsApi = fs,
  uid = currentUid(),
  now = Date.now,
  limits: limitOverrides,
  signal,
} = {}) {
  const bounded = limits(limitOverrides);
  const wanted = new Set([...sessionIds].filter((id) => UUID.test(id)));
  const bySession = new Map([...wanted].map((id) => [id, []]));
  if (wanted.size === 0) return { bySession, truncated: false, unsafeEntries: 0 };
  let root;
  try { root = await trustedRoot(projectsDirectory, { fsApi, uid }); }
  catch (error) {
    if (error?.code === "cursor_artifacts_not_found") return { bySession, truncated: false, unsafeEntries: 0 };
    throw error;
  }
  const deadline = now() + bounded.scanTimeoutMs;
  let projects = 0;
  let projectEntries = 0;
  let checks = 0;
  let candidates = 0;
  let totalBytes = 0;
  let truncated = false;
  let unsafeEntries = 0;
  let directory;
  try {
    directory = await fsApi.opendir(root);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      projectEntries += 1;
      if (now() > deadline || projectEntries > bounded.maxProjectEntries
        || projects >= bounded.maxProjects) { truncated = true; break; }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      projects += 1;
      const project = await trustedChildDirectory(root, join(root, entry.name), { fsApi, uid });
      const transcripts = project && await trustedChildDirectory(root, join(project, "agent-transcripts"), { fsApi, uid });
      if (!transcripts) continue;
      for (const id of wanted) {
        signal?.throwIfAborted();
        checks += 1;
        if (checks > bounded.maxProjectSessionChecks || now() > deadline
          || candidates >= bounded.maxTranscriptCandidates) {
          truncated = true;
          break;
        }
        const session = await trustedChildDirectory(root, join(transcripts, id), { fsApi, uid });
        if (!session) continue;
        const transcript = await trustedFile(root, join(session, `${id}.jsonl`), bounded.maxTranscriptBytes, { fsApi, uid });
        if (!transcript) { unsafeEntries += 1; continue; }
        if (totalBytes + transcript.size > bounded.maxTotalTranscriptBytes) { truncated = true; break; }
        totalBytes += transcript.size;
        candidates += 1;
        bySession.get(id).push({
          path: transcript.path,
          size: transcript.size,
          projectKey: entry.name.slice(0, 240),
        });
      }
      if (truncated) break;
    }
  } catch (error) {
    if (error instanceof CursorArtifactError) throw error;
    if (error?.name === "AbortError") throw error;
    throw artifactError("cursor_artifact_unsafe");
  } finally {
    try { await directory?.close(); } catch { /* async iterator may already close it */ }
  }
  return { bySession, truncated, unsafeEntries };
}

async function readBoundedFile(candidate, bounded, { fsApi = fs, uid = currentUid(), signal } = {}) {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await fsApi.open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || !owned(info, uid) || !Number.isSafeInteger(info.size)
      || info.size < 0 || info.size > bounded.maxTranscriptBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return undefined;
  } finally {
    try { await handle?.close(); } catch { /* best-effort descriptor cleanup */ }
  }
}

export async function parseCursorTranscript(candidate, {
  fsApi = fs,
  uid = currentUid(),
  limits: limitOverrides,
  signal,
} = {}) {
  const bounded = limits(limitOverrides);
  const buffer = await readBoundedFile(candidate, bounded, { fsApi, uid, signal });
  if (!buffer) return invalidTranscript("unreadable");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return invalidTranscript("invalid_utf8"); }
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  if (lines.length > bounded.maxLines) return invalidTranscript("too_many_lines");
  const recordHashes = [];
  const messages = [];
  let omittedBlocks = 0;
  let partial = false;
  let lastRecord;
  for (let index = 0; index < lines.length; index += 1) {
    signal?.throwIfAborted();
    const line = lines[index];
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > bounded.maxLineBytes) return invalidTranscript("line_too_large");
    let record;
    try { record = JSON.parse(line); }
    catch {
      if (!terminated && index === lines.length - 1) { partial = true; break; }
      return invalidTranscript("invalid_record");
    }
    let canonical;
    try { canonical = canonicalJson(record, bounded.maxCanonicalNodes); }
    catch { return invalidTranscript("record_too_complex"); }
    recordHashes.push(createHash("sha256").update(canonical).digest("base64url"));
    lastRecord = record;
    const extracted = textMessage(record);
    omittedBlocks += extracted.omittedBlocks;
    if (extracted.message) messages.push(extracted.message);
  }
  const boundedMessages = boundMessages(messages, bounded);
  return {
    valid: true,
    partial,
    recordHashes,
    status: partial ? "unknown" : terminalStatus(lastRecord),
    messages: boundedMessages.messages,
    messageCount: messages.length,
    omittedBlocks,
    truncated: boundedMessages.truncated,
    bytes: buffer.length,
  };
}

function invalidTranscript(reason) {
  return {
    valid: false,
    reason,
    partial: false,
    recordHashes: [],
    status: "unknown",
    messages: [],
    messageCount: 0,
    omittedBlocks: 0,
    truncated: false,
    bytes: 0,
  };
}

function canonicalJson(value, maxNodes) {
  let nodes = 0;
  const visit = (item) => {
    nodes += 1;
    if (nodes > maxNodes) throw new RangeError("canonical record node limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("non-finite JSON number");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(visit).join(",")}]`;
    if (typeof item === "object") {
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit(item[key])}`).join(",")}}`;
    }
    throw new TypeError("unsupported JSON value");
  };
  return visit(value);
}

function textMessage(record) {
  if (!record || !new Set(["user", "assistant"]).has(record.role)) return { omittedBlocks: 0 };
  const content = record.message?.content;
  if (typeof content === "string") return { message: { role: record.role, text: content }, omittedBlocks: 0 };
  if (!Array.isArray(content)) return { omittedBlocks: 0 };
  const text = [];
  let omittedBlocks = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else omittedBlocks += 1;
  }
  return { message: text.length ? { role: record.role, text: text.join("\n") } : undefined, omittedBlocks };
}

function boundMessages(messages, bounded) {
  const selected = [];
  let remaining = bounded.maxTextChars;
  let truncated = messages.length > bounded.maxMessages;
  for (let index = messages.length - 1; index >= 0 && selected.length < bounded.maxMessages && remaining > 0; index -= 1) {
    const message = messages[index];
    let text = message.text;
    if (text.length > bounded.maxMessageChars) {
      text = text.slice(0, bounded.maxMessageChars);
      truncated = true;
    }
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    remaining -= text.length;
    selected.unshift({ role: message.role, text });
  }
  if (selected.length < messages.length) truncated = true;
  return { messages: selected, truncated };
}

function terminalStatus(record) {
  if (record && record.type !== "turn_ended") return "working";
  if (!record) return "unknown";
  if (record.status === "success") return "idle";
  if (record.status === "error") return "error";
  return "unknown";
}

function isPrefix(left, right) {
  return left.length <= right.length && left.every((hash, index) => hash === right[index]);
}

export function reconcileCursorTranscripts(candidates) {
  if (!candidates.length) return {
    status: "unknown",
    readable: false,
    conflict: false,
    partial: false,
    transcriptCount: 0,
  };
  if (candidates.some((candidate) => !candidate.transcript.valid)) return {
    status: "unknown",
    readable: false,
    conflict: true,
    conflictKind: "corrupt",
    partial: candidates.some((candidate) => candidate.transcript.partial),
    transcriptCount: candidates.length,
  };
  const ordered = [...candidates].sort((left, right) => {
    const length = right.transcript.recordHashes.length - left.transcript.recordHashes.length;
    return length || left.projectKey.localeCompare(right.projectKey);
  });
  const selected = ordered[0];
  if (!ordered.every((candidate) => isPrefix(candidate.transcript.recordHashes, selected.transcript.recordHashes))) {
    return {
      status: "unknown",
      readable: false,
      conflict: true,
      conflictKind: "divergent",
      partial: candidates.some((candidate) => candidate.transcript.partial),
      transcriptCount: candidates.length,
    };
  }
  const partial = candidates.some((candidate) => candidate.transcript.partial);
  return {
    status: partial ? "unknown" : selected.transcript.status,
    readable: true,
    conflict: false,
    partial,
    transcriptCount: candidates.length,
    workspaceCandidate: workspaceCandidate(selected.projectKey),
    messages: selected.transcript.messages,
    messageCount: selected.transcript.messageCount,
    omittedBlocks: selected.transcript.omittedBlocks,
    truncated: selected.transcript.truncated,
  };
}

function workspaceCandidate(projectKey) {
  const name = String(projectKey ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
  if (!name) return undefined;
  return {
    id: `cursor-workspace:${createHash("sha256").update(name).digest("base64url").slice(0, 22)}`,
    name,
    confidence: "low",
  };
}

export async function inspectCursorTranscripts({ candidatesBySession, parseOptions } = {}) {
  const result = new Map();
  for (const [sessionId, candidates] of candidatesBySession) {
    const parsed = [];
    for (const candidate of candidates) {
      const transcript = await parseCursorTranscript(candidate, parseOptions);
      parsed.push({ ...candidate, transcript });
    }
    result.set(sessionId, reconcileCursorTranscripts(parsed));
  }
  return result;
}
