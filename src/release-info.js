import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../release-compatibility.json", import.meta.url), "utf8"));

export const RELEASE_COMPATIBILITY = Object.freeze(manifest);

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
