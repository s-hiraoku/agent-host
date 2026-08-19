import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertDisabledCursorSdkArtifactPaths,
  assertDisabledCursorSdkDependencyMetadata,
  assertDisabledCursorSdkSourceManifest,
  DISABLED_CURSOR_SDK_RELEASE_POLICY,
  verifyDashboardArtifactAttestation,
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
  assert.throws(
    () => assertDisabledCursorSdkSourceManifest({ dependencies: { bridge: "npm:@cursor/sdk@1.0.28" } }),
    /source manifest dependencies contains bridge/,
  );
  assert.throws(
    () => assertDisabledCursorSdkDependencyMetadata({ packages: { "": { dependencies: { bridge: "npm:@cursor/sdk-linux-x64@1" } } } }, "fixture lockfile"),
    /fixture lockfile contains Cursor SDK dependency reference bridge/,
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

  await t.test("dashboard package-lock alias", async (t) => {
    const fixture = await releaseFixture(t);
    const lockPath = join(fixture, "dashboard-source", "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages[""].dependencies = { bridge: "npm:@cursor/sdk@1.0.28" };
    await writeFile(lockPath, JSON.stringify(lock));
    await assert.rejects(() => buildFixture(fixture), /dashboard dependency lockfile contains Cursor SDK dependency reference bridge/);
  });

  for (const path of ["assets/cursor-sdk-bundle.js", "node_modules/innocent/index.js"]) {
    await t.test(`staged ${path}`, async (t) => {
      const fixture = await releaseFixture(t);
      await mkdir(dirname(join(fixture, "dashboard-source", "dist", path)), { recursive: true });
      await writeFile(join(fixture, "dashboard-source", "dist", path), "fixture");
      await assert.rejects(() => buildFixture(fixture), /(?:staged release tree contains|dashboard artifact file set differs)/);
    });
  }
});

test("dashboard attestation rejects extra, missing, and modified generic assets", async (t) => {
  for (const mutation of ["extra", "missing", "modified"]) {
    await t.test(mutation, async (t) => {
      const fixture = await releaseFixture(t);
      const dist = join(fixture, "dashboard-source", "dist");
      if (mutation === "extra") await writeFile(join(dist, "assets.js"), "generic bundle\n");
      if (mutation === "missing") await rm(join(dist, "assets", "app.js"));
      if (mutation === "modified") await writeFile(join(dist, "index.html"), "changed generic bundle\n");
      await assert.rejects(() => buildFixture(fixture), /dashboard artifact (?:file set|content) differs/);
    });
  }
});

test("dashboard attestation rejects malformed, duplicate, and unsorted entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-dashboard-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "fixture");
  const valid = { path: "index.html", bytes: 7, sha256: sha256("fixture") };
  for (const entry of [
    { ...valid, path: "../index.html" },
    { ...valid, path: "/index.html" },
    { ...valid, bytes: -1 },
    { ...valid, sha256: "invalid" },
  ]) {
    await assert.rejects(
      () => verifyDashboardArtifactAttestation(root, { dashboard: { artifact: { schemaVersion: 1, files: [entry] } } }),
      /attestation contains an invalid entry/,
    );
  }
  for (const files of [[valid, valid], [{ ...valid, path: "z.js" }, valid]]) {
    await assert.rejects(
      () => verifyDashboardArtifactAttestation(root, { dashboard: { artifact: { schemaVersion: 1, files } } }),
      /attestation paths are not unique and sorted/,
    );
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
  await verifyDisabledCursorSdkArchive(safe.archive, safe.compatibilityBytes);

  for (const path of [
    "vendor/@cursor/sdk/index.js",
    "assets/cursor_sdk_bridge.cjs",
    "node_modules/empty/.keep",
  ]) {
    const archive = await archiveFixture(t, path);
    await assert.rejects(
      () => verifyDisabledCursorSdkArchive(archive.archive, archive.compatibilityBytes),
      /disabled Cursor SDK release policy v1 rejected extracted final archive/,
    );
  }

  const forbiddenManifest = await archiveFixture(t, "dashboard/index.html", {
    dependencies: { "@cursor/sdk": "1.0.0" },
  });
  await assert.rejects(
    () => verifyDisabledCursorSdkArchive(forbiddenManifest.archive, forbiddenManifest.compatibilityBytes),
    /source manifest dependencies contains @cursor\/sdk/,
  );
});

test("final archive rejects a modified generic bundle with a matching self-attestation", async (t) => {
  const fixture = await selfAttestedArchiveFixture(t);
  await assert.rejects(
    () => verifyDisabledCursorSdkArchive(fixture.archive, fixture.expectedCompatibilityBytes),
    /final archive release compatibility differs from the pinned source/,
  );
});

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-build-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(join(repository, "scripts", "build-release.js"), join(root, "scripts", "build-release.js"));
  await cp(join(repository, "scripts", "release-artifact-policy.js"), join(root, "scripts", "release-artifact-policy.js"));
  await cp(join(repository, "scripts", "build-anchored-private-state-helper.js"),
    join(root, "scripts", "build-anchored-private-state-helper.js"));
  await cp(join(repository, "native"), join(root, "native"), { recursive: true });
  await writeFile(join(root, "scripts", "manage-installation.js"), "");
  for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) await writeFile(join(root, file), "fixture\n");
  for (const directory of ["src", "docs", "dashboard-source/dist"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "src", "cli.js"), "");
  await writeFile(join(root, "docs", "fixture.md"), "fixture\n");
  await writeFile(join(root, "dashboard-source", "dist", "index.html"), "fixture\n");
  await mkdir(join(root, "dashboard-source", "dist", "assets"));
  await writeFile(join(root, "dashboard-source", "dist", "assets", "app.js"), "app\n");
  const dashboardPackage = JSON.stringify({ name: "agent-host-dashboard", version: "0.3.0" });
  const dashboardLock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "agent-host-dashboard" } } });
  await writeFile(join(root, "dashboard-source", "package.json"), dashboardPackage);
  await writeFile(join(root, "dashboard-source", "package-lock.json"), dashboardLock);
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
      buildInputs: {
        packageJsonSha256: sha256(dashboardPackage),
        packageLockSha256: sha256(dashboardLock),
      },
      artifact: {
        schemaVersion: 1,
        files: [
          { path: "assets/app.js", bytes: 4, sha256: sha256("app\n") },
          { path: "index.html", bytes: 8, sha256: sha256("fixture\n") },
        ],
      },
    },
  }));
  return root;
}

async function buildFixture(root, env = process.env) {
  await run(process.execPath, [
    join(root, "scripts", "build-release.js"),
    `--dashboard-dir=${join(root, "dashboard-source", "dist")}`,
    `--output=${join(root, "dist")}`,
  ], { env });
}

async function archiveFixture(t, path, packageFields = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "agent-host-archive-fixture-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "agent-host-0.3.0");
  if (path !== "dashboard/index.html") {
    await mkdir(join(root, "dashboard"), { recursive: true });
    await writeFile(join(root, "dashboard", "index.html"), "fixture");
  }
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), "fixture");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-host", ...packageFields }));
  const compatibilityBytes = Buffer.from(JSON.stringify({
    dashboard: {
      artifact: {
        schemaVersion: 1,
        files: [{ path: "index.html", bytes: 7, sha256: sha256("fixture") }],
      },
    },
  }));
  await writeFile(join(root, "release-compatibility.json"), compatibilityBytes);
  const archive = join(fixture, `${path.replaceAll("/", "-")}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", fixture, "agent-host-0.3.0"]);
  return { archive, compatibilityBytes };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function selfAttestedArchiveFixture(t) {
  const fixture = await mkdtemp(join(tmpdir(), "agent-host-self-attested-archive-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "agent-host-0.3.0");
  await mkdir(join(root, "dashboard", "assets"), { recursive: true });
  await writeFile(join(root, "dashboard", "index.html"), "fixture");
  await writeFile(join(root, "dashboard", "assets", "generic.js"), "modified bundle");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-host" }));
  const expectedCompatibilityBytes = Buffer.from(JSON.stringify({
    dashboard: { artifact: { schemaVersion: 1, files: [
      { path: "index.html", bytes: 7, sha256: sha256("fixture") },
    ] } },
  }));
  const embeddedCompatibilityBytes = Buffer.from(JSON.stringify({
    dashboard: { artifact: { schemaVersion: 1, files: [
      { path: "assets/generic.js", bytes: 15, sha256: sha256("modified bundle") },
      { path: "index.html", bytes: 7, sha256: sha256("fixture") },
    ] } },
  }));
  await writeFile(join(root, "release-compatibility.json"), embeddedCompatibilityBytes);
  const archive = join(fixture, "tampered.tar.gz");
  await run("tar", ["-czf", archive, "-C", fixture, "agent-host-0.3.0"]);
  return { archive, expectedCompatibilityBytes };
}
