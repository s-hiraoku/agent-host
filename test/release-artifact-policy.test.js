import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertDisabledCursorSdkArtifactPaths,
  assertDisabledCursorSdkSourceManifest,
  DISABLED_CURSOR_SDK_RELEASE_POLICY,
  verifyDisabledCursorSdkArchive,
} from "../scripts/release-artifact-policy.js";

const run = promisify(execFile);
const repository = join(import.meta.dirname, "..");

test("disabled Cursor SDK release policy is explicit and versioned", async () => {
  assert.deepEqual(DISABLED_CURSOR_SDK_RELEASE_POLICY, {
    schemaVersion: 1,
    provider: "cursor-sdk",
    status: "disabled",
  });
  assertDisabledCursorSdkSourceManifest(JSON.parse(await readFile(join(repository, "package.json"), "utf8")));
});

test("source manifest rejects Cursor SDK and platform packages", () => {
  for (const [field, name] of [
    ["dependencies", "@cursor/sdk"],
    ["optionalDependencies", "@cursor/sdk-darwin-arm64"],
    ["devDependencies", "@cursor/sdk-linux-x64"],
  ]) {
    assert.throws(
      () => assertDisabledCursorSdkSourceManifest({ [field]: { [name]: "1.0.0" } }),
      new RegExp(`source manifest ${field} contains`),
    );
  }
  assert.throws(
    () => assertDisabledCursorSdkSourceManifest({ bundledDependencies: ["@cursor/sdk"] }),
    /source manifest bundledDependencies contains/,
  );
});

test("staged release paths reject SDK packages, bridge bundles, and every node_modules entry", () => {
  for (const path of [
    "vendor/@cursor/sdk/index.js",
    "vendor/@cursor/sdk-darwin-arm64/native.node",
    "dashboard/assets/cursor-sdk-bridge.mjs",
    "dashboard/empty/node_modules",
  ]) {
    assert.throws(
      () => assertDisabledCursorSdkArtifactPaths([path], "fixture staging tree"),
      /disabled Cursor SDK release policy v1 rejected fixture staging tree/,
    );
  }
});

test("release build fails on forbidden source manifest and staged dashboard fixtures", async (t) => {
  await t.test("source manifest package", async (t) => {
    const fixture = await releaseFixture(t);
    const manifest = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
    manifest.dependencies = { "@cursor/sdk": "1.0.0" };
    await writeFile(join(fixture, "package.json"), JSON.stringify(manifest));
    await assert.rejects(() => buildFixture(fixture), /source manifest dependencies contains @cursor\/sdk/);
  });

  for (const path of ["assets/cursor-sdk-bundle.js", "node_modules/innocent/index.js"]) {
    await t.test(`staged ${path}`, async (t) => {
      const fixture = await releaseFixture(t);
      await mkdir(dirname(join(fixture, "dashboard", path)), { recursive: true });
      await writeFile(join(fixture, "dashboard", path), "fixture");
      await assert.rejects(() => buildFixture(fixture), /staged release tree contains/);
    });
  }
});

test("failed final archive verification publishes no archive or pending output", async (t) => {
  const fixture = await releaseFixture(t);
  const bin = join(fixture, "bin");
  await mkdir(bin);
  const fakeTar = join(bin, "tar");
  await writeFile(fakeTar, `#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const createIndex = args.indexOf("-czf");
if (createIndex === -1) process.exit(spawnSync("/usr/bin/tar", args, { stdio: "inherit" }).status ?? 1);
const root = mkdtempSync(join(tmpdir(), "agent-host-forbidden-tar-"));
try {
  mkdirSync(join(root, "agent-host-0.3.0", "node_modules"), { recursive: true });
  writeFileSync(join(root, "agent-host-0.3.0", "node_modules", ".keep"), "fixture");
  writeFileSync(join(root, "agent-host-0.3.0", "package.json"), "{}");
  process.exit(spawnSync("/usr/bin/tar", ["-czf", args[createIndex + 1], "-C", root, "agent-host-0.3.0"], { stdio: "inherit" }).status ?? 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`);
  await chmod(fakeTar, 0o755);

  await assert.rejects(
    () => buildFixture(fixture, { PATH: `${bin}:${process.env.PATH}` }),
    /extracted final archive contains node_modules entry/,
  );
  assert.deepEqual(await readdir(join(fixture, "dist")), []);
});

test("final archive is extracted and forbidden archive fixtures are rejected", async (t) => {
  const safe = await archiveFixture(t, "dashboard/index.html");
  await verifyDisabledCursorSdkArchive(safe);

  for (const path of [
    "vendor/@cursor/sdk/index.js",
    "assets/cursor_sdk_bridge.cjs",
    "node_modules/empty/.keep",
  ]) {
    const archive = await archiveFixture(t, path);
    await assert.rejects(
      () => verifyDisabledCursorSdkArchive(archive),
      /disabled Cursor SDK release policy v1 rejected extracted final archive/,
    );
  }

  const forbiddenManifest = await archiveFixture(t, "dashboard/index.html", {
    dependencies: { "@cursor/sdk": "1.0.0" },
  });
  await assert.rejects(
    () => verifyDisabledCursorSdkArchive(forbiddenManifest),
    /source manifest dependencies contains @cursor\/sdk/,
  );
});

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-build-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(join(repository, "scripts", "build-release.js"), join(root, "scripts", "build-release.js"));
  await cp(join(repository, "scripts", "release-artifact-policy.js"), join(root, "scripts", "release-artifact-policy.js"));
  await writeFile(join(root, "scripts", "manage-installation.js"), "");
  for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) await writeFile(join(root, file), "fixture\n");
  for (const directory of ["src", "docs", "dashboard"]) await mkdir(join(root, directory));
  await writeFile(join(root, "src", "cli.js"), "");
  await writeFile(join(root, "docs", "fixture.md"), "fixture\n");
  await writeFile(join(root, "dashboard", "index.html"), "fixture\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "agent-host",
    version: "0.3.0",
    type: "module",
    license: "MIT",
  }));
  await writeFile(join(root, "release-compatibility.json"), JSON.stringify({
    productVersion: "0.3.0",
    apiVersions: ["1"],
    dashboard: {
      version: "0.3.0",
      apiVersions: ["1"],
      repository: "s-hiraoku/agent-host-dashboard",
      commit: "fixture",
    },
  }));
  return root;
}

async function buildFixture(root, env = process.env) {
  await run(process.execPath, [
    join(root, "scripts", "build-release.js"),
    `--dashboard-dir=${join(root, "dashboard")}`,
    `--output=${join(root, "dist")}`,
  ], { env });
}

async function archiveFixture(t, path, packageFields = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "agent-host-archive-fixture-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "agent-host-0.3.0");
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), "fixture");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-host", ...packageFields }));
  const archive = join(fixture, `${path.replaceAll("/", "-")}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", fixture, "agent-host-0.3.0"]);
  return archive;
}
