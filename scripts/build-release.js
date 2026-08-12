#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=", 2)));
const dashboardDirectory = resolve(args["--dashboard-dir"] ?? "");
const outputDirectory = resolve(args["--output"] ?? join(repository, "dist"));
const packageJson = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const compatibility = JSON.parse(await readFile(join(repository, "release-compatibility.json"), "utf8"));
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
  for (const entry of ["LICENSE", "README.md", "CHANGELOG.md", "package.json", "release-compatibility.json", "src", "docs"]) {
    await cp(join(repository, entry), join(root, entry), { recursive: true });
  }
  await mkdir(join(root, "scripts"));
  await cp(join(repository, "scripts", "manage-installation.js"), join(root, "scripts", "manage-installation.js"));
  await cp(dashboardDirectory, join(root, "dashboard"), { recursive: true });
  const files = await collectFiles(root);
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
  const tarArgs = process.platform === "linux"
    ? ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", temporary, name]
    : ["-czf", archive, "-C", temporary, name];
  await run("tar", tarArgs);
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

async function collectFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact input contains symlink: ${path}`);
    if (entry.isDirectory()) result.push(...await collectFiles(root, path));
    else if (entry.isFile()) result.push(path.slice(root.length + 1));
    else throw new Error(`artifact input contains unsupported entry: ${path}`);
  }
  return result.sort();
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
      { SPDXID: "SPDXRef-agent-host", name: packageJson.name, versionInfo: packageJson.version, downloadLocation: "NOASSERTION", filesAnalyzed: true, licenseConcluded: packageJson.license },
      { SPDXID: "SPDXRef-dashboard", name: "agent-host-dashboard", versionInfo: compatibility.dashboard.version, downloadLocation: `git+https://github.com/${compatibility.dashboard.repository}@${compatibility.dashboard.commit}`, filesAnalyzed: true, licenseConcluded: "NOASSERTION" },
    ],
  };
}
