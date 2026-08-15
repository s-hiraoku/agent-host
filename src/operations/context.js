import { createRedactor } from "./redact.js";
import { StructuredLogger } from "./logger.js";
import { OperationalMetrics } from "./metrics.js";
import { readFileSync } from "node:fs";
import { publicReleaseInfo } from "../release-info.js";

export const AGENT_HOST_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function diagnosticVersions() {
  return {
    agentHost: AGENT_HOST_VERSION,
    ...publicReleaseInfo(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export class OperationsContext {
  constructor(options = {}) {
    this.redact = options.redact ?? createRedactor(options);
    this.metrics = options.metrics ?? new OperationalMetrics();
    this.logger = options.logger ?? new StructuredLogger({
      path: options.logFile,
      level: options.logLevel,
      redact: this.redact,
      ...options.loggerOptions,
    });
  }

  snapshot(extra = {}) {
    return this.redact({
      generatedAt: new Date().toISOString(),
      versions: diagnosticVersions(),
      metrics: this.metrics.snapshot(),
      logging: this.logger.sinkStatus(),
      recentLogs: this.logger.recent(),
      ...extra,
    });
  }

  close() { this.logger.close(); }
}
