#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertDisabledCursorSdkArtifactPaths,
  assertDisabledCursorSdkDependencyMetadata,
  assertDisabledCursorSdkSourceManifest,
  verifyDashboardArtifactAttestation,
  verifyDisabledCursorSdkArchive,
} from "./release-artifact-policy.js";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=", 2)));
if (!args["--dashboard-dir"]) {
  throw new Error("--dashboard-dir is required; run npm run release:build -- --dashboard-dir=/path/to/dashboard/dist");
}
const dashboardDirectory = resolve(args["--dashboard-dir"]);
const dashboardSourceDirectory = resolve(args["--dashboard-source-dir"] ?? dirname(dashboardDirectory));
const outputDirectory = resolve(args["--output"] ?? join(repository, "dist"));
const packageJson = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const compatibilityBytes = await readFile(join(repository, "release-compatibility.json"));
const compatibility = JSON.parse(compatibilityBytes);
assertDisabledCursorSdkSourceManifest(packageJson);
const dashboardPackageBytes = await readFile(join(dashboardSourceDirectory, "package.json"));
const dashboardLockBytes = await readFile(join(dashboardSourceDirectory, "package-lock.json"));
const dashboardPackage = JSON.parse(dashboardPackageBytes);
const dashboardLock = JSON.parse(dashboardLockBytes);
assertDisabledCursorSdkSourceManifest(dashboardPackage);
assertDisabledCursorSdkDependencyMetadata(dashboardPackage, "dashboard package manifest");
assertDisabledCursorSdkDependencyMetadata(dashboardLock, "dashboard dependency lockfile");
verifyDashboardBuildInput("package.json", dashboardPackageBytes, compatibility.dashboard.buildInputs?.packageJsonSha256);
verifyDashboardBuildInput("package-lock.json", dashboardLockBytes, compatibility.dashboard.buildInputs?.packageLockSha256);
if (packageJson.version !== compatibility.productVersion) throw new Error("package and release compatibility versions differ");
if (!compatibility.apiVersions.some((version) => compatibility.dashboard.apiVersions.includes(version))) {
  throw new Error("pinned dashboard has no compatible agent-host API version");
}
await readFile(join(dashboardDirectory, "index.html"));

const temporary = await mkdtemp(join(tmpdir(), "agent-host-release-"));
const name = `agent-host-${packageJson.version}`;
const root = join(temporary, name);
try {
  await mkdir(root, { recursive: true });
  for (const entry of ["LICENSE", "README.md", "CHANGELOG.md", "package.json", "release-compatibility.json", "src", "docs", "native"]) {
    await cp(join(repository, entry), join(root, entry), { recursive: true });
  }
  assertDisabledCursorSdkSourceManifest(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  await mkdir(join(root, "scripts"));
  await cp(join(repository, "scripts", "manage-installation.js"), join(root, "scripts", "manage-installation.js"));
  await cp(join(repository, "scripts", "build-anchored-private-state-helper.js"), join(root, "scripts", "build-anchored-private-state-helper.js"));
  await cp(dashboardDirectory, join(root, "dashboard"), { recursive: true });
  await verifyDashboardArtifactAttestation(join(root, "dashboard"), compatibility);
  const entries = await collectEntries(root);
  assertDisabledCursorSdkArtifactPaths(entries.map((entry) => entry.path), "staged release tree");
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
  await scanArtifact(root, files);
  const fileManifest = [];
  for (const path of files) {
    const contents = await readFile(join(root, path));
    fileManifest.push({ path, bytes: contents.length, sha256: sha256(contents) });
  }
  await writeFile(join(root, "release-files.json"), `${JSON.stringify({ schemaVersion: 1, files: fileManifest }, null, 2)}\n`);
  await writeFile(join(root, "sbom.spdx.json"), `${JSON.stringify(spdx(packageJson, compatibility), null, 2)}\n`);
  await mkdir(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, `${name}.tar.gz`);
  const pendingArchive = join(outputDirectory, `.${name}-${randomUUID()}.tar.gz.tmp`);
  const tarArgs = process.platform === "linux"
    ? ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", pendingArchive, "-C", temporary, name]
    : ["-czf", pendingArchive, "-C", temporary, name];
  try {
    await run("tar", tarArgs);
    await verifyDisabledCursorSdkArchive(pendingArchive, compatibilityBytes);
    await rename(pendingArchive, archive);
  } finally {
    await rm(pendingArchive, { force: true });
  }
  const releaseManifest = join(outputDirectory, `${name}-release-manifest.json`);
  const sbom = join(outputDirectory, `${name}.spdx.json`);
  await cp(join(repository, "release-compatibility.json"), releaseManifest);
  await cp(join(root, "sbom.spdx.json"), sbom);
  const outputs = [archive, releaseManifest, sbom];
  const checksums = [];
  for (const path of outputs) checksums.push(`${sha256(await readFile(path))}  ${basename(path)}`);
  await writeFile(join(outputDirectory, "checksums.txt"), `${checksums.join("\n")}\n`);
  const archiveContents = await readFile(archive);
  console.log(JSON.stringify({ archive, sha256: sha256(archiveContents), files: fileManifest.length }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function collectEntries(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact input contains symlink: ${path}`);
    const relativePath = path.slice(root.length + 1);
    if (entry.isDirectory()) result.push({ path: relativePath, type: "directory" }, ...await collectEntries(root, path));
    else if (entry.isFile()) result.push({ path: relativePath, type: "file" });
    else throw new Error(`artifact input contains unsupported entry: ${path}`);
  }
  return result.sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1);
}

async function scanArtifact(root, files) {
  const forbiddenNames = /(^|\/)(\.git|\.env|node_modules|ledger|test|fixtures)(\/|$)|(^|\/)(token|agent-host\.lock|diagnostics\.json)$/;
  const forbiddenContent = /(\/Users\/[^/\s]+\/|Bearer\s+[A-Za-z0-9._~-]{16,}|AGENT_HOST_API_TOKEN\s*=\s*[^\s"']+)/;
  for (const path of files) {
    if (forbiddenNames.test(path)) throw new Error(`forbidden artifact path: ${path}`);
    const contents = await readFile(join(root, path));
    if (contents.includes(0)) continue;
    if (forbiddenContent.test(contents.toString("utf8"))) throw new Error(`possible local path or secret in artifact: ${path}`);
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function verifyDashboardBuildInput(name, contents, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || sha256(contents) !== expectedSha256) {
    throw new Error(`pinned dashboard ${name} does not match release compatibility`);
  }
}

function spdx(packageJson, compatibility) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `agent-host-${packageJson.version}`,
    documentNamespace: `https://github.com/s-hiraoku/agent-host/releases/tag/v${packageJson.version}`,
    creationInfo: {
      created: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 0) * 1_000).toISOString(),
      creators: ["Tool: agent-host-build-release"],
    },
    packages: [
      { SPDXID: "SPDXRef-agent-host", name: packageJson.name, versionInfo: packageJson.version, downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: packageJson.license, licenseDeclared: packageJson.license, copyrightText: "NOASSERTION" },
      { SPDXID: "SPDXRef-dashboard", name: "agent-host-dashboard", versionInfo: compatibility.dashboard.version, downloadLocation: `git+https://github.com/${compatibility.dashboard.repository}@${compatibility.dashboard.commit}`, filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION" },
    ],
  };
}
