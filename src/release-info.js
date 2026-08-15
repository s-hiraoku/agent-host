import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../release-compatibility.json", import.meta.url), "utf8"));

export const RELEASE_COMPATIBILITY = deepFreeze(manifest);

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function publicReleaseInfo() {
  return {
    serverVersion: manifest.productVersion,
    apiVersions: [...manifest.apiVersions],
    configSchema: { reads: [...manifest.configSchema.reads], writes: manifest.configSchema.writes },
    dashboard: {
      version: manifest.dashboard.version,
      apiVersions: [...manifest.dashboard.apiVersions],
    },
  };
}
