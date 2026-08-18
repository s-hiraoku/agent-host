#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const supported = new Set(["darwin", "linux"]);
if (!supported.has(process.platform)) throw new Error(`anchored private state is unsupported on ${process.platform}`);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? `${repository}/build/anchored-private-state`);
await mkdir(dirname(output), { recursive: true });
await assertMissing(output);
const temporary = `${output}.${randomUUID()}.tmp`;
try {
  await promisify(execFile)(process.env.CC ?? "cc", [
    "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    `${repository}/native/anchored-private-state.c`, "-o", temporary,
  ]);
  await chmod(temporary, 0o500);
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(output);

async function assertMissing(path) {
  try { await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to replace existing helper: ${path}`);
}
