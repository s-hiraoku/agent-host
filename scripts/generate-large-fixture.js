import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noCapabilities } from "../src/core/types.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "fixtures", "client-conformance", "large-list.json");
const statuses = ["unknown", "idle", "working", "blocked", "done", "error"];
const agents = Array.from({ length: 1_000 }, (_, index) => ({
  id: `demo:scale:${String(index + 1).padStart(4, "0")}`,
  provider: "demo",
  source: "demo-fixture",
  name: `Demo scale agent ${String(index + 1).padStart(4, "0")}`,
  status: statuses[index % statuses.length],
  capabilities: {
    ...noCapabilities(),
    read: index % 4 === 0,
    prompt: index % 4 === 1,
    interrupt: index % 4 === 2,
    approve: index % 4 === 3,
    reject: index % 4 === 3,
  },
  lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  discovery: { kind: "fixture", confidence: "high", visibility: index < 20 ? "active" : "recent" },
}));

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ fixtureVersion: 1, scenario: "large-list", agents }, null, 2)}\n`);
