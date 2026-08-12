#!/usr/bin/env node
import { runCli } from "./cli-app.js";

try { process.exitCode = await runCli(); }
catch (error) {
  console.error(`[agent-host] ${error?.message ?? error}`);
  process.exitCode = 1;
}
