#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installRelease, installationStatus, rollbackRelease, uninstallRelease,
} from "../src/installation.js";

const operation = process.argv[2] ?? "status";
const source = resolve(process.argv[3] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const prefix = resolve(process.env.AGENT_HOST_INSTALL_ROOT ?? join(homedir(), ".local", "share", "agent-host"));
const binDirectory = resolve(process.env.AGENT_HOST_BIN_DIR ?? join(homedir(), ".local", "bin"));
let result;
if (operation === "install" || operation === "update") result = await installRelease({ source, prefix, binDirectory });
else if (operation === "rollback") result = await rollbackRelease({ prefix, binDirectory });
else if (operation === "uninstall") result = await uninstallRelease({ prefix, binDirectory });
else if (operation === "status") result = await installationStatus(prefix);
else throw new Error("usage: manage-installation.js <install|update|rollback|uninstall|status> [extracted-release]");
console.log(JSON.stringify(result, null, 2));
