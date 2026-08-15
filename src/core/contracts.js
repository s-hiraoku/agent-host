import { compareAgents, matchesView } from "./discovery.js";

export const API_VERSION = "1";
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const STATUSES = new Set(["unknown", "idle", "working", "blocked", "done", "error"]);
const VIEWS = new Set(["active", "recent", "historical", "raw"]);
const CAPABILITIES = ["prompt", "sendKeys", "approve", "reject", "interrupt", "focus", "read"];

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function approvalView(approval) {
  return compact({
    approvalId: approval?.approvalId,
    method: approval?.method,
    threadId: approval?.threadId,
    turnId: approval?.turnId,
    itemId: approval?.itemId,
    reason: approval?.reason,
    command: approval?.command,
    cwd: approval?.cwd,
    availableDecisions: approval?.availableDecisions,
  });
}

export function agentSummary(agent) {
  const pendingApprovals = agent.pendingApprovals ?? [];
  return compact({
    id: agent.id,
    provider: agent.provider,
    source: agent.source,
    name: agent.name,
    status: agent.status,
    capabilities: Object.fromEntries(CAPABILITIES.map((name) => [name, Boolean(agent.capabilities?.[name])])),
    cwd: agent.cwd,
    lastActivityAt: agent.lastActivityAt ?? agent.updatedAt,
    discoveredAt: agent.discoveredAt,
    updatedAt: agent.updatedAt,
    pendingApprovalCount: pendingApprovals.length,
    discovery: agent.discovery ? compact({
      kind: agent.discovery.kind,
      confidence: agent.discovery.confidence,
      visibility: agent.discovery.visibility,
      provenance: agent.discovery.provenance,
      duplicateOf: agent.discovery.duplicateOf,
    }) : undefined,
  });
}

export function agentDetail(agent) {
  return compact({
    ...agentSummary(agent),
    sessionId: agent.sessionId,
    target: agent.target,
    pid: agent.pid,
    tty: agent.tty,
    activeTurnId: agent.activeTurnId,
    pendingApprovals: (agent.pendingApprovals ?? []).map(approvalView),
  });
}

export function actionResult(result, agentId, action) {
  return compact({
    ok: true,
    agentId: result.agentId ?? agentId,
    action: result.action ?? action,
    data: result.data,
  });
}

export function eventView(event) {
  if (!event.agent) return { ...event };
  const { cwd: _cwd, pendingApprovals = [], ...agent } = agentDetail(event.agent);
  return {
    ...event,
    agent: {
      ...agent,
      pendingApprovals: pendingApprovals.map(({ cwd: _approvalCwd, ...approval }) => approval),
    },
  };
}

export function parseAgentListQuery(searchParams, revision) {
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ContractError("invalid_limit", `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }

  const providers = values(searchParams, "provider");
  const statuses = values(searchParams, "status");
  const invalidStatus = statuses.find((status) => !STATUSES.has(status));
  if (invalidStatus) throw new ContractError("invalid_status", `unsupported status: ${invalidStatus}`);
  const view = searchParams.get("view") ?? "recent";
  if (!VIEWS.has(view)) throw new ContractError("invalid_view", `unsupported view: ${view}`);

  const filter = {
    view,
    providers,
    statuses,
    cwd: searchParams.get("cwd")?.trim().toLocaleLowerCase() ?? "",
    query: searchParams.get("q")?.trim().toLocaleLowerCase() ?? "",
  };
  const filterKey = JSON.stringify(filter);
  const cursor = searchParams.get("cursor");
  const offset = cursor ? decodeCursor(cursor, revision, filterKey) : 0;
  return { limit, offset, filter, filterKey };
}

export function pageAgents(agents, query, revision) {
  const filtered = agents.filter((agent) => matches(agent, query.filter)).sort(compareAgents);
  if (query.offset > filtered.length) {
    throw new ContractError("invalid_cursor", "cursor offset is outside the current result set");
  }
  const page = filtered.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + page.length;
  return {
    agents: page.map(agentSummary),
    page: compact({
      limit: query.limit,
      total: filtered.length,
      nextCursor: nextOffset < filtered.length
        ? encodeCursor(nextOffset, revision, query.filterKey)
        : undefined,
    }),
  };
}

export class ContractError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function values(searchParams, key) {
  return [...new Set(searchParams.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))]
    .sort();
}

function matches(agent, filter) {
  if (!matchesView(agent, filter.view)) return false;
  if (filter.providers.length && !filter.providers.includes(agent.provider)) return false;
  if (filter.statuses.length && !filter.statuses.includes(agent.status)) return false;
  if (filter.cwd && !agent.cwd?.toLocaleLowerCase().includes(filter.cwd)) return false;
  if (filter.query) {
    const haystack = [agent.name, agent.provider, agent.source, agent.cwd]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase();
    if (!haystack.includes(filter.query)) return false;
  }
  return true;
}

function encodeCursor(offset, revision, filterKey) {
  return Buffer.from(JSON.stringify({ offset, revision, filterKey })).toString("base64url");
}

function decodeCursor(cursor, revision, filterKey) {
  let payload;
  try { payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new ContractError("invalid_cursor", "cursor is malformed"); }
  if (!Number.isInteger(payload?.offset) || payload.offset < 0) {
    throw new ContractError("invalid_cursor", "cursor offset is invalid");
  }
  if (payload.revision !== revision) {
    throw new ContractError("stale_cursor", "the agent snapshot changed; restart pagination", 409);
  }
  if (payload.filterKey !== filterKey) {
    throw new ContractError("invalid_cursor", "cursor does not match the current filters");
  }
  return payload.offset;
}
