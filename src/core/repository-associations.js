import { isDeepStrictEqual } from "node:util";

export const REPOSITORY_ASSOCIATION_VERSION = "1";
export const MAX_REPOSITORY_ASSOCIATIONS = 100;
const MAX_RAW_REPOSITORY_ASSOCIATIONS = 200;

const MAX = Object.freeze({
  forge: 32,
  host: 253,
  owner: 160,
  name: 100,
  opaque: 200,
  repositoryId: 128,
  webUrl: 500,
  branch: 255,
  worktreeId: 128,
});
const CONTEXT_STATES = new Set(["ready", "unsupported", "unavailable"]);
const FRESHNESS = new Set(["current", "stale"]);
const ASSOCIATION_KINDS = new Set(["confirmed", "candidate"]);
const PROVENANCE_SOURCES = new Set(["adapter-authoritative", "user-declared", "adapter-heuristic"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const CANDIDATE_REASONS = new Set(["repository_match", "branch_match", "adapter_heuristic"]);
const VISIBILITY = new Set(["public", "private", "internal", "unknown"]);

export function repositoryAssociationCapabilities() {
  return {
    status: "supported",
    versions: [REPOSITORY_ASSOCIATION_VERSION],
    endpointTemplate: "/v1/agents/{agentId}/repository-associations?version={version}",
    maxItems: MAX_REPOSITORY_ASSOCIATIONS,
    events: ["agent.repository-associations.changed"],
    replay: false,
  };
}

export function parseRepositoryAssociationVersion(searchParams) {
  const version = searchParams.get("version") ?? REPOSITORY_ASSOCIATION_VERSION;
  if (version !== REPOSITORY_ASSOCIATION_VERSION) {
    const error = new Error("requested repository association version is not supported");
    error.code = "unsupported_repository_association_version";
    error.status = 406;
    throw error;
  }
  return version;
}

export function normalizeRepositoryContext(input) {
  if (input === undefined || input === null) return unsupportedContext();
  if (!plainObject(input) || !CONTEXT_STATES.has(input.state)) return partialContext([], 1, 0);
  if (input.state === "unsupported") return unsupportedContext();
  if (input.state === "unavailable") {
    return {
      state: "unavailable",
      error: {
        code: "repository_associations_unavailable",
        retryable: input.error?.retryable !== false,
      },
    };
  }

  const source = Array.isArray(input.associations) ? input.associations : [];
  let rejectedCount = Array.isArray(input.associations) ? 0 : 1;
  const normalized = [];
  const seen = new Set();
  for (const item of source.slice(0, MAX_RAW_REPOSITORY_ASSOCIATIONS)) {
    try {
      const association = normalizeAssociation(item);
      const key = JSON.stringify(association);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(association);
    } catch {
      rejectedCount += 1;
    }
  }
  normalized.sort(compareAssociations);
  const associations = normalized.slice(0, MAX_REPOSITORY_ASSOCIATIONS);
  const overflowCount = Math.max(0, normalized.length - MAX_REPOSITORY_ASSOCIATIONS)
    + Math.max(0, source.length - MAX_RAW_REPOSITORY_ASSOCIATIONS);

  let observedAt;
  if (input.observedAt !== undefined) {
    try { observedAt = isoTimestamp(input.observedAt); }
    catch { rejectedCount += 1; }
  }

  const complete = input.complete !== false && rejectedCount === 0 && overflowCount === 0;
  const context = {
    state: "ready",
    freshness: FRESHNESS.has(input.freshness) ? input.freshness : "current",
    complete,
    associations,
  };
  if (!complete) {
    context.error = {
      code: "repository_associations_partial",
      retryable: input.error?.retryable === true,
      rejectedCount,
      overflowCount,
    };
  }
  if (observedAt !== undefined) context.observedAt = observedAt;
  return context;
}

export function repositoryContextsEqual(left, right) {
  return isDeepStrictEqual(normalizeRepositoryContext(left), normalizeRepositoryContext(right));
}

function unsupportedContext() {
  return { state: "unsupported", reason: "adapter_not_supported" };
}

function partialContext(associations, rejectedCount, overflowCount) {
  return {
    state: "ready",
    freshness: "current",
    complete: false,
    associations,
    error: {
      code: "repository_associations_partial",
      retryable: false,
      rejectedCount,
      overflowCount,
    },
  };
}

function normalizeAssociation(input) {
  if (!plainObject(input) || !ASSOCIATION_KINDS.has(input.kind)) throw new TypeError("invalid association kind");
  const repository = normalizeRepository(input.repository);
  const provenance = normalizeProvenance(input.provenance, input.kind);
  const association = { kind: input.kind, repository, provenance };
  if (input.checkout !== undefined) association.checkout = normalizeCheckout(input.checkout);
  if (input.kind === "candidate") {
    if (!CANDIDATE_REASONS.has(input.reason)) throw new TypeError("invalid candidate reason");
    if (input.reason === "branch_match" && !association.checkout?.branch) {
      throw new TypeError("branch candidates require a branch");
    }
    association.reason = input.reason;
    if (input.pullRequest !== undefined) throw new TypeError("candidate associations cannot identify a pull request");
  } else if (input.pullRequest !== undefined) {
    association.pullRequest = normalizePullRequest(input.pullRequest, repository.host);
  }
  return association;
}

function normalizeRepository(input) {
  if (!plainObject(input)) throw new TypeError("invalid repository");
  const forge = boundedString(input.forge, "forge", MAX.forge).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(forge)) throw new TypeError("invalid forge");
  const host = boundedString(input.host, "host", MAX.host).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new TypeError("invalid repository host");
  }
  const coordinates = normalizeCoordinates(input.coordinates);
  const webUrl = httpsUrl(input.webUrl, host);
  const repository = { forge, host, coordinates, webUrl };
  if (input.repositoryId !== undefined) {
    repository.repositoryId = boundedString(input.repositoryId, "repositoryId", MAX.repositoryId);
  }
  if (input.visibility !== undefined) {
    if (!VISIBILITY.has(input.visibility)) throw new TypeError("invalid repository visibility");
    repository.visibility = input.visibility;
  }
  return repository;
}

function normalizeCoordinates(input) {
  if (!plainObject(input)) throw new TypeError("invalid repository coordinates");
  if (input.kind === "named") {
    const owner = boundedString(input.owner, "owner", MAX.owner);
    const name = boundedString(input.name, "name", MAX.name);
    if (!safeCoordinate(owner, true) || !safeCoordinate(name, false)) throw new TypeError("invalid named coordinates");
    return { kind: "named", owner, name };
  }
  if (input.kind === "opaque") {
    const value = boundedString(input.value, "opaque coordinates", MAX.opaque);
    if (!safeCoordinate(value, true)) throw new TypeError("invalid opaque coordinates");
    return { kind: "opaque", value };
  }
  throw new TypeError("invalid coordinate kind");
}

function normalizeProvenance(input, kind) {
  if (!plainObject(input) || !PROVENANCE_SOURCES.has(input.source) || !CONFIDENCE.has(input.confidence)) {
    throw new TypeError("invalid association provenance");
  }
  if (kind === "confirmed" && (input.source === "adapter-heuristic" || input.confidence !== "high")) {
    throw new TypeError("confirmed associations require high-confidence non-heuristic provenance");
  }
  if (kind === "candidate" && input.confidence === "high") {
    throw new TypeError("candidate associations cannot be high confidence");
  }
  return { source: input.source, confidence: input.confidence };
}

function normalizeCheckout(input) {
  if (!plainObject(input)) throw new TypeError("invalid checkout context");
  const checkout = {};
  if (input.branch !== undefined) checkout.branch = boundedString(input.branch, "branch", MAX.branch);
  if (input.worktree !== undefined) {
    if (!plainObject(input.worktree)) throw new TypeError("invalid worktree context");
    const id = boundedString(input.worktree.id, "worktree id", MAX.worktreeId);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TypeError("worktree id must be opaque, not a local path");
    checkout.worktree = { id };
  }
  if (!Object.keys(checkout).length) throw new TypeError("empty checkout context");
  return checkout;
}

function normalizePullRequest(input, host) {
  if (!plainObject(input) || !Number.isSafeInteger(input.number) || input.number < 1) {
    throw new TypeError("invalid pull request coordinates");
  }
  const pullRequest = { number: input.number };
  if (input.webUrl !== undefined) pullRequest.webUrl = httpsUrl(input.webUrl, host);
  return pullRequest;
}

function httpsUrl(value, host) {
  const text = boundedString(value, "webUrl", MAX.webUrl);
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new TypeError("invalid web URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== host
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("web URL must be canonical HTTPS on the repository host");
  }
  return parsed.toString();
}

function isoTimestamp(value) {
  const text = boundedString(value, "observedAt", 40);
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) throw new TypeError("invalid observedAt");
  return text;
}

function safeCoordinate(value, allowSlash) {
  if (/[\u0000-\u001f\u007f\\?#]/.test(value) || /^\s|\s$/.test(value)) return false;
  if (!allowSlash && value.includes("/")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function boundedString(value, name, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareAssociations(left, right) {
  const leftKey = associationKey(left);
  const rightKey = associationKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function associationKey(association) {
  const repository = association.repository;
  const coordinates = repository.coordinates.kind === "named"
    ? `named:${repository.coordinates.owner}/${repository.coordinates.name}`
    : `opaque:${repository.coordinates.value}`;
  return [
    repository.forge,
    repository.host,
    coordinates,
    association.kind === "confirmed" ? "0" : "1",
    association.checkout?.branch ?? "",
    String(association.pullRequest?.number ?? ""),
    JSON.stringify(association),
  ].join("\n");
}
