import { compareAgents, matchesView } from "./discovery.js";
import { createHash } from "node:crypto";
import { posix, sep, win32 } from "node:path";

export const API_VERSION = "1";
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const STATUSES = new Set(["unknown", "idle", "working", "blocked", "done", "error"]);
const VIEWS = new Set(["active", "recent", "historical", "raw"]);
const SORTS = new Set(["attention", "activity", "name", "provider", "status"]);
const DIRECTIONS = new Set(["asc", "desc"]);
const CAPABILITIES = ["prompt", "sendKeys", "approve", "reject", "interrupt", "focus", "read"];

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function approvalView(approval) {
  const context = approvalContextView(approval?.context);
  const actionable = approval?.method === "item/fileChange/requestApproval"
    ? Boolean(approval?.actionable && context?.files.length)
    : approval?.actionable;
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
    context: actionable === false ? undefined : context,
    actionable,
  });
}

export function isActionableApproval(approval) {
  if (!approval || approval.actionable === false) return false;
  return approval.method !== "item/fileChange/requestApproval" || approvalView(approval).actionable === true;
}

function approvalContextView(context) {
  if (context?.kind !== "file-change") return undefined;
  const supplied = Array.isArray(context.files) ? context.files : [];
  const validated = supplied.flatMap((file) => {
    const path = publicApprovalPath(file?.path);
    if (!path) return [];
    return [{
      path,
      kind: ["add", "delete", "update"].includes(file.kind) ? file.kind : "update",
    }];
  });
  if (validated.length !== supplied.length || validated.length === 0) return undefined;
  const files = validated.slice(0, 20);
  const fileCount = Number.isInteger(context.fileCount) && context.fileCount >= files.length
    ? context.fileCount
    : files.length;
  return {
    kind: "file-change",
    fileCount,
    files,
    truncated: Boolean(context.truncated) || supplied.length > files.length || fileCount > files.length,
  };
}

function publicApprovalPath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const portable = sep === "\\" ? value.replaceAll("\\", "/") : value;
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return undefined;
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  const normalized = segments.join("/");
  return normalized.length <= 240 ? normalized : undefined;
}

export function projectView(cwd, platform = process.platform) {
  const paths = platform === "win32" ? win32 : posix;
  if (typeof cwd !== "string" || !paths.isAbsolute(cwd)) return undefined;
  const resolved = paths.resolve(cwd);
  const canonical = platform === "win32" ? resolved.toLowerCase() : resolved;
  return {
    id: `local:${createHash("sha256").update(canonical).digest("base64url").slice(0, 22)}`,
    name: paths.basename(resolved) || resolved,
    scope: "local",
  };
}

export function agentSummary(agent) {
  const pendingApprovals = agent.pendingApprovals ?? [];
  const hasActionableApproval = pendingApprovals.some((approval) => {
    return isActionableApproval(approval);
  });
  return compact({
    id: agent.id,
    provider: agent.provider,
    source: agent.source,
    name: agent.name,
    status: agent.status,
    capabilities: Object.fromEntries(CAPABILITIES.map((name) => [name, Boolean(
      agent.capabilities?.[name] && (!["approve", "reject"].includes(name) || hasActionableApproval),
    )])),
    cwd: agent.cwd,
    project: projectView(agent.cwd),
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
  return event.agent ? { ...event, agent: agentDetail(event.agent) } : { ...event };
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
  const sort = searchParams.get("sort") ?? "attention";
  if (!SORTS.has(sort)) throw new ContractError("invalid_sort", `unsupported sort: ${sort}`);
  const direction = searchParams.get("direction") ?? (sort === "activity" ? "desc" : "asc");
  if (!DIRECTIONS.has(direction)) throw new ContractError("invalid_direction", `unsupported direction: ${direction}`);

  const filter = {
    view,
    providers,
    statuses,
    cwd: searchParams.get("cwd")?.trim().toLocaleLowerCase() ?? "",
    query: searchParams.get("q")?.trim().toLocaleLowerCase() ?? "",
    sort,
    direction,
  };
  const filterKey = JSON.stringify(filter);
  const cursor = searchParams.get("cursor");
  const offset = cursor ? decodeCursor(cursor, revision, filterKey) : 0;
  return { limit, offset, filter, filterKey };
}

export function pageAgents(agents, query, revision) {
  const filtered = agents.filter((agent) => matches(agent, query.filter)).sort(comparator(query.filter));
  if (query.offset > filtered.length) {
    throw new ContractError("invalid_cursor", "cursor offset is outside the current result set");
  }
  const page = filtered.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + page.length;
  return {
    agents: page.map(agentSummary),
    facets: facetsFor(agents, query.filter, revision),
    page: compact({
      limit: query.limit,
      total: filtered.length,
      sort: query.filter.sort,
      direction: query.filter.direction,
      nextCursor: nextOffset < filtered.length
        ? encodeCursor(nextOffset, revision, query.filterKey)
        : undefined,
    }),
  };
}

function comparator(filter) {
  const direction = filter.direction === "desc" ? -1 : 1;
  if (filter.sort === "attention") return (left, right) => direction * compareAgents(left, right);
  return (left, right) => {
    let result;
    if (filter.sort === "activity") {
      result = compareText(left.lastActivityAt ?? left.updatedAt, right.lastActivityAt ?? right.updatedAt);
    } else if (filter.sort === "status") {
      result = compareText(left.status, right.status);
    } else {
      result = compareText(left[filter.sort], right[filter.sort]);
    }
    return result ? direction * result : compareText(left.id, right.id);
  };
}

function compareText(left, right) {
  const a = String(left ?? "").normalize("NFKC").toLowerCase();
  const b = String(right ?? "").normalize("NFKC").toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function facetsFor(agents, filter, revision) {
  const withoutProviders = { ...filter, providers: [] };
  const withoutStatuses = { ...filter, statuses: [] };
  return {
    revision,
    providers: counts(agents.filter((agent) => matches(agent, withoutProviders)), "provider"),
    statuses: counts(agents.filter((agent) => matches(agent, withoutStatuses)), "status"),
  };
}

function counts(agents, field) {
  const result = new Map();
  for (const agent of agents) result.set(agent[field], (result.get(agent[field]) ?? 0) + 1);
  return [...result].sort(([left], [right]) => compareText(left, right))
    .map(([value, count]) => ({ value, count }));
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
