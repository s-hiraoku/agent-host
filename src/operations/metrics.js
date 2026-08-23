const HISTOGRAM_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 5_000, 20_000, Infinity];
const COUNTERS = new Set([
  "adapter_failures", "adapter_reconnects", "circuit_skips", "circuit_probes",
  "sse_connections", "sse_reconnects", "sse_overflows", "actions_rejected",
  "launches_rejected",
]);
const GAUGES = new Set(["event_subscribers", "action_queue_depth", "launch_queue_depth", "sse_queue_depth"]);
const HISTOGRAMS = new Set(["refresh_duration_ms", "action_latency_ms", "launch_latency_ms"]);
const LABELS = {
  adapter_failures: ["adapter"],
  adapter_reconnects: ["adapter"],
  circuit_skips: ["adapter"],
  circuit_probes: ["adapter", "outcome"],
  sse_reconnects: ["transport"],
  actions_rejected: ["code"],
  launches_rejected: ["code"],
  action_latency_ms: ["actionKind", "outcome"],
  launch_latency_ms: ["provider", "outcome"],
};
const LABEL_VALUES = {
  adapter: new Set(["codex", "cursor-sdk", "herdr", "process", "demo", "other"]),
  transport: new Set(["dashboard_sse", "codex_rpc", "other"]),
  actionKind: new Set(["prompt", "send-keys", "approve", "reject", "interrupt", "focus", "read", "other"]),
  provider: new Set(["cursor", "demo", "other"]),
  outcome: new Set(["success", "failure", "timeout", "other"]),
  code: new Set(["queue_full", "shutting_down", "other"]),
};

export class OperationalMetrics {
  #counters = new Map();
  #gauges = new Map();
  #histograms = new Map();

  increment(name, labels = {}, amount = 1) {
    if (!COUNTERS.has(name)) throw new Error(`unknown counter: ${name}`);
    const key = seriesKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  setGauge(name, value, labels = {}) {
    if (!GAUGES.has(name)) throw new Error(`unknown gauge: ${name}`);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`gauge ${name} requires a finite value`);
    this.#gauges.set(seriesKey(name, labels), numeric);
  }

  observe(name, value, labels = {}) {
    if (!HISTOGRAMS.has(name)) throw new Error(`unknown histogram: ${name}`);
    const observed = Number(value);
    if (!Number.isFinite(observed)) throw new TypeError(`histogram ${name} requires a finite value`);
    const key = seriesKey(name, labels);
    const histogram = this.#histograms.get(key) ?? {
      count: 0,
      sum: 0,
      max: 0,
      buckets: HISTOGRAM_BUCKETS_MS.map((upperBound) => ({
        upperBound: upperBound === Infinity ? "+Inf" : upperBound,
        count: 0,
      })),
    };
    histogram.count += 1;
    histogram.sum += observed;
    histogram.max = Math.max(histogram.max, observed);
    for (const bucket of histogram.buckets) {
      if (bucket.upperBound === "+Inf" || observed <= bucket.upperBound) bucket.count += 1;
    }
    this.#histograms.set(key, histogram);
  }

  snapshot() {
    const memory = process.memoryUsage();
    return {
      counters: records(this.#counters),
      gauges: records(this.#gauges),
      histograms: records(this.#histograms),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      seriesCount: this.#counters.size + this.#gauges.size + this.#histograms.size,
    };
  }
}

function seriesKey(name, labels) {
  const allowedKeys = LABELS[name] ?? [];
  const normalized = Object.fromEntries(allowedKeys.map((key) => [key, normalizeLabel(key, labels[key]) ]));
  return JSON.stringify({ name, labels: normalized });
}

function normalizeLabel(key, value) {
  const candidate = String(value ?? "other");
  return LABEL_VALUES[key]?.has(candidate) ? candidate : "other";
}

function records(map) {
  return [...map.entries()].map(([key, value]) => ({ ...JSON.parse(key), value }));
}

export { HISTOGRAM_BUCKETS_MS };
