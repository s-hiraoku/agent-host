import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = join(import.meta.dirname, "..");
const builder = join(repository, "scripts", "build-anchored-private-state-helper.js");

test("native helper publication never replaces a concurrently created destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-native-builder-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "anchored-private-state");
  const wrapper = join(directory, "compiler-wrapper.mjs");
  await writeFile(wrapper, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
execFileSync(process.env.REAL_CC, process.argv.slice(2), { stdio: "inherit" });
writeFileSync(process.env.BUILDER_OUTPUT, "concurrent-owner\\n", { flag: "wx", mode: 0o500 });
`);
  await chmod(wrapper, 0o700);

  await assert.rejects(run(process.execPath, [builder, output], {
    env: {
      ...process.env,
      CC: wrapper,
      REAL_CC: process.env.CC ?? "cc",
      BUILDER_OUTPUT: output,
    },
  }), /refusing to replace existing helper/);
  assert.equal(await readFile(output, "utf8"), "concurrent-owner\n");
  assert.deepEqual((await readdir(directory)).sort(), ["anchored-private-state", "compiler-wrapper.mjs"]);
});

test("concurrent native helper builders publish exactly one complete output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-native-builder-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "anchored-private-state");
  const results = await Promise.allSettled([
    run(process.execPath, [builder, output]),
    run(process.execPath, [builder, output]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected"
    && /refusing to replace existing helper/.test(result.reason?.message)).length, 1);
  const state = await lstat(output);
  assert.equal(state.isFile(), true);
  assert.notEqual(state.mode & 0o100, 0);
  assert.deepEqual(await readdir(directory), ["anchored-private-state"]);
});
