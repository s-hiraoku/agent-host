import { homedir } from "node:os";
import { join } from "node:path";
import { noCapabilities } from "../core/types.js";
import {
  cursorProfileScope,
  findCursorTranscriptCandidates,
  inspectCursorTranscripts,
  readCursorConversationRows,
} from "./cursor-artifacts.js";
import { createMacAppFocus, MAC_DESKTOP_APPS } from "./mac-app-focus.js";

const DEFAULT_RECENT_LIMIT = 100;
const MAX_HISTORY_SESSIONS = 1_000;
const DEFAULT_RECENT_MS = 7 * 24 * 60 * 60_000;

export function defaultCursorDesktopPaths({
  homeDirectory = homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  let userDataDirectory;
  if (platform === "darwin") {
    userDataDirectory = join(homeDirectory, "Library", "Application Support", "Cursor");
  } else if (platform === "win32") {
    userDataDirectory = join(env.APPDATA || join(homeDirectory, "AppData", "Roaming"), "Cursor");
  } else {
    userDataDirectory = join(env.XDG_CONFIG_HOME || join(homeDirectory, ".config"), "Cursor");
  }
  return {
    userDataDirectory,
    projectsDirectory: join(homeDirectory, ".cursor", "projects"),
  };
}

export class CursorDesktopAdapter {
  id = "cursor-desktop";
  #userDataDirectory;
  #projectsDirectory;
  #profileScope;
  #readConversations;
  #findTranscripts;
  #inspectTranscripts;
  #now;
  #recentMs;
  #limits;
  #fsApi;
  #uid;
  #appFocus;
  #focusApp;
  #focusAvailable = false;

  constructor(options = {}) {
    const defaults = defaultCursorDesktopPaths(options);
    this.#userDataDirectory = options.userDataDirectory ?? defaults.userDataDirectory;
    this.#projectsDirectory = options.projectsDirectory ?? defaults.projectsDirectory;
    this.#profileScope = options.profileScope ?? cursorProfileScope(this.#userDataDirectory);
    this.#readConversations = options.readConversations ?? readCursorConversationRows;
    this.#findTranscripts = options.findTranscripts ?? findCursorTranscriptCandidates;
    this.#inspectTranscripts = options.inspectTranscripts ?? inspectCursorTranscripts;
    this.#now = options.now ?? Date.now;
    this.#recentMs = options.recentMs ?? DEFAULT_RECENT_MS;
    this.#limits = options.limits;
    this.#fsApi = options.fsApi;
    this.#uid = options.uid;
    this.#appFocus = options.appFocus ?? createMacAppFocus(options.appFocusOptions);
    this.#focusApp = options.focusApp ?? MAC_DESKTOP_APPS.cursor;
  }

  async discover(options = {}) {
    return this.#discover(false, DEFAULT_RECENT_LIMIT, options);
  }

  async discoverHistory(options = {}) {
    return this.#discover(true, MAX_HISTORY_SESSIONS, options);
  }

  async #discover(includeArchived, limit, options) {
    options.signal?.throwIfAborted();
    const rows = await this.#readConversations({
      userDataDirectory: this.#userDataDirectory,
      includeArchived,
      limit,
      fsApi: this.#fsApi,
      uid: this.#uid,
      limits: this.#limits,
    });
    options.signal?.throwIfAborted();
    const scan = await this.#findTranscripts({
      projectsDirectory: this.#projectsDirectory,
      sessionIds: rows.map((row) => row.id),
      fsApi: this.#fsApi,
      uid: this.#uid,
      limits: this.#limits,
      now: this.#now,
      signal: options.signal,
    });
    const transcripts = await this.#inspectTranscripts({
      candidatesBySession: scan.bySession,
      parseOptions: {
        fsApi: this.#fsApi,
        uid: this.#uid,
        limits: this.#limits,
        signal: options.signal,
      },
    });
    options.signal?.throwIfAborted();
    this.#focusAvailable = await this.#appFocus.available(this.#focusApp);
    const discoveredAt = new Date().toISOString();
    return rows.map((row) => this.#agent(row, transcripts.get(row.id), scan, discoveredAt));
  }

  #agent(row, transcript, scan, discoveredAt) {
    const lastActivityAt = new Date(row.updatedAt).toISOString();
    const recent = this.#now() - row.updatedAt <= this.#recentMs;
    const capabilities = noCapabilities();
    capabilities.read = !scan.truncated && Boolean(transcript?.readable);
    capabilities.focus = this.#focusAvailable;
    const conflict = Boolean(scan.truncated || transcript?.conflict);
    return {
      id: `cursor-desktop:${this.#profileScope}:${row.id}`,
      provider: "cursor",
      source: this.id,
      name: row.title,
      status: scan.truncated ? "unknown" : transcript?.status ?? "unknown",
      capabilities,
      sessionId: row.id,
      target: row.id,
      lastActivityAt,
      workspaceCandidate: transcript?.workspaceCandidate,
      discovery: {
        kind: "native",
        confidence: conflict ? "low" : "high",
        provenance: "cursor-local-artifacts",
        visibility: row.archived || !recent ? "historical" : "recent",
      },
      metadata: {
        cursorDesktop: {
          profileScope: this.#profileScope,
          archived: row.archived,
          rootFingerprintPresent: Boolean(row.rootFingerprint),
          transcriptCount: transcript?.transcriptCount ?? 0,
          conflict,
          conflictKind: scan.truncated ? "scan-truncated" : transcript?.conflictKind,
          partial: Boolean(transcript?.partial),
          scanTruncated: Boolean(scan.truncated),
          unsafeEntryCount: scan.unsafeEntries,
        },
      },
      discoveredAt,
      updatedAt: discoveredAt,
    };
  }

  markStale(agent) {
    return {
      ...agent,
      status: "unknown",
      capabilities: noCapabilities(),
      discovery: {
        ...agent.discovery,
        confidence: "low",
        visibility: agent.discovery?.visibility === "historical" ? "historical" : "recent",
      },
    };
  }

  async focus(agent) {
    if (!this.#focusAvailable) {
      return failure(agent, "focus", "capability_not_available", "capability focus is not available");
    }
    const result = await this.#appFocus.activate(this.#focusApp);
    if (!result.ok) {
      return failure(
        agent,
        "focus",
        result.code ?? "desktop_focus_failed",
        "Cursor application could not be brought to the front",
      );
    }
    return { ok: true, agentId: agent.id, action: "focus" };
  }

  async read(agent, options = {}) {
    const sessionId = agent?.sessionId;
    if (!sessionId || agent?.metadata?.cursorDesktop?.profileScope !== this.#profileScope) {
      return failure(agent, "read", "cursor_transcript_unavailable", "Cursor transcript is unavailable");
    }
    try {
      const scan = await this.#findTranscripts({
        projectsDirectory: this.#projectsDirectory,
        sessionIds: [sessionId],
        fsApi: this.#fsApi,
        uid: this.#uid,
        limits: this.#limits,
        now: this.#now,
        signal: options.signal,
      });
      if (scan.truncated) {
        return failure(agent, "read", "cursor_transcript_conflict", "Cursor transcript artifacts conflict");
      }
      const transcripts = await this.#inspectTranscripts({
        candidatesBySession: scan.bySession,
        parseOptions: {
          fsApi: this.#fsApi,
          uid: this.#uid,
          limits: this.#limits,
          signal: options.signal,
        },
      });
      const transcript = transcripts.get(sessionId);
      if (transcript?.conflict) {
        return failure(agent, "read", "cursor_transcript_conflict", "Cursor transcript artifacts conflict");
      }
      if (!transcript?.readable) {
        return failure(agent, "read", "cursor_transcript_unavailable", "Cursor transcript is unavailable");
      }
      return {
        ok: true,
        agentId: agent.id,
        action: "read",
        data: {
          messages: transcript.messages,
          messageCount: transcript.messageCount,
          omittedBlockCount: transcript.omittedBlocks,
          truncated: Boolean(transcript.truncated || scan.truncated),
        },
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return failure(agent, "read", error?.code ?? "cursor_transcript_unavailable", "Cursor transcript is unavailable");
    }
  }
}

function failure(agent, action, code, message) {
  return {
    ok: false,
    code,
    agentId: agent?.id,
    action,
    message,
  };
}
