const SENSITIVE_KEY = /(?:^|[._-])(?:authorization|cookie|token|secret|password|prompt|text|command|metadata|environment|headers?)(?:[._-]|$)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function createRedactor(options = {}) {
  const homeDirectory = options.homeDirectory?.replace(/\/+$/, "");
  const secrets = [...new Set((options.secrets ?? []).filter((value) => typeof value === "string" && value.length >= 8))]
    .sort((left, right) => right.length - left.length);
  const paths = [...new Set((options.paths ?? []).filter((value) => typeof value === "string" && value.startsWith("/")))]
    .sort((left, right) => right.length - left.length);
  return (value) => sanitize(value, { homeDirectory, secrets, paths, seen: new WeakSet(), depth: 0 });
}

function sanitize(value, state, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, state);
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return undefined;
  const structured = state.structured || key === "metrics" || key === "readiness";
  if (state.depth >= (structured ? 8 : 4)) return "[TRUNCATED]";
  if (state.seen.has(value)) return "[CIRCULAR]";
  state.seen.add(value);
  const childState = { ...state, depth: state.depth + 1, structured };
  if (value instanceof Error) {
    return compact({
      name: sanitizeString(value.name, state),
      code: typeof value.code === "string" ? sanitizeString(value.code, state) : undefined,
      message: sanitizeString(value.message, state),
    });
  }
  if (Array.isArray(value)) {
    const limit = key === "recentLogs" ? 200 : ["counters", "gauges", "histograms", "buckets"].includes(key) ? 64 : 20;
    return value.slice(0, limit).map((entry) => sanitize(entry, childState));
  }
  const entries = Object.entries(value).slice(0, 32).map(([entryKey, entry]) => [
    entryKey.slice(0, 64),
    sanitize(entry, childState, entryKey),
  ]).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries);
}

function sanitizeString(value, state) {
  let result = value.replace(BEARER, "Bearer [REDACTED]");
  for (const secret of state.secrets) result = result.replaceAll(secret, "[REDACTED]");
  if (state.homeDirectory) result = result.replaceAll(state.homeDirectory, "$HOME");
  for (const path of state.paths) result = result.replaceAll(path, `$PATH/${path.split("/").at(-1)}`);
  result = result.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, candidate.endsWith("/") ? "/" : "");
    } catch { return candidate; }
  });
  return result.replace(/[\r\n\t]+/g, " ").slice(0, 512);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
