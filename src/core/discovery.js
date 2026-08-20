const ACTIVE_STATUSES = new Set(["working", "blocked"]);
const STATUS_RANK = new Map([["blocked", 0], ["working", 1], ["idle", 2], ["unknown", 3], ["done", 4], ["error", 5]]);

export function reconcileAgents(agents, includeDuplicates = false) {
  const richByProcess = new Map();
  for (const agent of agents) {
    if (agent.discovery?.kind === "process" || !agent.pid) continue;
    richByProcess.set(`${agent.provider}:${agent.pid}`, agent.id);
  }

  return agents.flatMap((agent) => {
    if (!includeDuplicates && agent.discovery?.visibility === "raw") return [];
    if (agent.discovery?.kind !== "process" || !agent.pid) return [agent];
    const duplicateOf = richByProcess.get(`${agent.provider}:${agent.pid}`);
    if (!duplicateOf) return [agent];
    const duplicate = {
      ...agent,
      discovery: { ...agent.discovery, visibility: "raw", duplicateOf },
    };
    return includeDuplicates ? [duplicate] : [];
  });
}

export function matchesView(agent, view) {
  const visibility = agent.discovery?.visibility ?? (ACTIVE_STATUSES.has(agent.status) ? "active" : "recent");
  if (view === "active") return visibility === "active";
  if (view === "historical") return visibility === "historical";
  if (view === "raw") return true;
  return visibility === "active" || visibility === "recent";
}

export function compareAgents(a, b) {
  const status = (STATUS_RANK.get(a.status) ?? 6) - (STATUS_RANK.get(b.status) ?? 6);
  if (status) return status;
  const action = Number(hasAction(b)) - Number(hasAction(a));
  if (action) return action;
  const aVisibility = a.discovery?.visibility === "active" ? 0 : 1;
  const bVisibility = b.discovery?.visibility === "active" ? 0 : 1;
  if (aVisibility !== bVisibility) return aVisibility - bVisibility;
  const activity = compareActivity(a.lastActivityAt, b.lastActivityAt);
  if (activity) return activity;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function hasAction(agent) {
  const capabilities = agent.capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  return Object.values(capabilities).some(Boolean);
}

function compareActivity(left, right) {
  const a = Date.parse(left ?? "");
  const b = Date.parse(right ?? "");
  if (Number.isFinite(a) && Number.isFinite(b)) return a < b ? 1 : a > b ? -1 : 0;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  const aText = String(left ?? "");
  const bText = String(right ?? "");
  return aText < bText ? 1 : aText > bText ? -1 : 0;
}
