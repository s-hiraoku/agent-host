import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DISABLED_CURSOR_SDK_RELEASE_POLICY = Object.freeze({
  schemaVersion: 1,
  provider: "cursor-sdk",
  status: "disabled",
});

export function assertDisabledCursorSdkSourceManifest(manifest) {
  const dependencyFields = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ];
  for (const field of dependencyFields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (isCursorSdkPackage(name) || isCursorSdkSpecifier(specifier)) {
        reject(`source manifest ${field} contains ${name}`);
      }
    }
  }
  for (const name of manifest.bundledDependencies ?? manifest.bundleDependencies ?? []) {
    if (isCursorSdkPackage(name)) reject(`source manifest bundledDependencies contains ${name}`);
  }
}

export function assertDisabledCursorSdkDependencyMetadata(metadata, boundary) {
  visitDependencyMetadata(metadata, boundary);
}

export async function verifyDashboardArtifactAttestation(dashboardRoot, compatibility) {
  const attestation = compatibility?.dashboard?.artifact;
  if (attestation?.schemaVersion !== 1 || !Array.isArray(attestation.files)) {
    reject("release compatibility lacks dashboard artifact attestation v1");
  }
  const actualEntries = await collectTreeEntries(dashboardRoot);
  const actualFiles = actualEntries.filter((entry) => !entry.endsWith("/")).sort();
  const expectedFiles = attestation.files.map((entry, index) => {
    validateAttestationEntry(entry);
    if (index > 0 && attestation.files[index - 1].path >= entry.path) {
      reject("dashboard artifact attestation paths are not unique and sorted");
    }
    return entry.path;
  });
  if (new Set(expectedFiles).size !== expectedFiles.length) {
    reject("dashboard artifact attestation paths are not unique and sorted");
  }
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((path, index) => path !== expectedFiles[index])) {
    reject("dashboard artifact file set differs from the pinned attestation");
  }
  for (const expected of attestation.files) {
    const contents = await readFile(join(dashboardRoot, expected.path));
    if (contents.length !== expected.bytes || sha256(contents) !== expected.sha256) {
      reject(`dashboard artifact content differs at ${expected.path}`);
    }
  }
}

export function assertDisabledCursorSdkArtifactPaths(paths, boundary) {
  for (const original of paths) {
    const path = normalizedArtifactPath(original);
    const parts = path.split("/").filter(Boolean);
    if (parts.includes("node_modules")) reject(`${boundary} contains node_modules entry ${path}`);
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (parts[index] === "@cursor" && /^sdk(?:-|$)/.test(parts[index + 1])) {
        reject(`${boundary} contains Cursor SDK package entry ${path}`);
      }
    }
    if (/^cursor[-_.]?sdk[-_.]?(?:bridge|bundle)(?:[-_.].*)?$/i.test(basename(path))) {
      reject(`${boundary} contains Cursor SDK bridge bundle ${path}`);
    }
  }
}

export async function verifyDisabledCursorSdkArchive(archive, expectedCompatibilityBytes) {
  if (!Buffer.isBuffer(expectedCompatibilityBytes)) {
    throw new TypeError("expected release compatibility bytes are required");
  }
  const { stdout } = await run("tar", ["-tzf", archive]);
  const archiveEntries = stdout.split("\n").filter(Boolean);
  for (const entry of archiveEntries) validateArchiveEntry(entry);
  const roots = new Set(archiveEntries.map((entry) => normalizedArtifactPath(entry).split("/")[0]));
  if (roots.size !== 1) throw new Error("release archive must contain exactly one top-level directory");

  const extraction = await mkdtemp(join(tmpdir(), "agent-host-release-proof-"));
  try {
    await run("tar", ["-xzf", archive, "-C", extraction]);
    const releaseRoot = join(extraction, [...roots][0]);
    const extractedEntries = await collectTreeEntries(releaseRoot);
    assertDisabledCursorSdkArtifactPaths(extractedEntries, "extracted final archive");
    assertDisabledCursorSdkSourceManifest(
      JSON.parse(await readFile(join(releaseRoot, "package.json"), "utf8")),
    );
    const embeddedCompatibilityBytes = await readFile(join(releaseRoot, "release-compatibility.json"));
    if (!embeddedCompatibilityBytes.equals(expectedCompatibilityBytes)) {
      reject("final archive release compatibility differs from the pinned source");
    }
    const compatibility = JSON.parse(embeddedCompatibilityBytes);
    await verifyDashboardArtifactAttestation(join(releaseRoot, "dashboard"), compatibility);
    assertDisabledCursorSdkArtifactPaths(archiveEntries, "final archive index");
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

function validateAttestationEntry(entry) {
  const path = entry?.path;
  if (typeof path !== "string"
    || !path
    || path !== normalizedArtifactPath(path)
    || path.startsWith("/")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 0
    || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
    reject("dashboard artifact attestation contains an invalid entry");
  }
}

function isCursorSdkPackage(name) {
  return name === "@cursor/sdk" || name.startsWith("@cursor/sdk-");
}

function isCursorSdkSpecifier(value) {
  return typeof value === "string" && /^npm:@cursor\/sdk(?:-|@|$)/i.test(value);
}

function visitDependencyMetadata(value, boundary) {
  if (Array.isArray(value)) {
    for (const entry of value) visitDependencyMetadata(entry, boundary);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (isCursorSdkPackage(key)
      || (typeof entry === "string" && isCursorSdkPackage(entry))
      || /(?:^|\/)node_modules\/@cursor\/sdk(?:-|$)/.test(key)
      || isCursorSdkSpecifier(entry)) {
      reject(`${boundary} contains Cursor SDK dependency reference ${key}`);
    }
    visitDependencyMetadata(entry, boundary);
  }
}

function normalizedArtifactPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function validateArchiveEntry(entry) {
  const path = normalizedArtifactPath(entry);
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe release archive entry: ${entry}`);
  }
}

async function collectTreeEntries(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = path.slice(root.length + 1);
    if (entry.isSymbolicLink()) throw new Error(`release archive contains symlink: ${relativePath}`);
    if (entry.isDirectory()) result.push(`${relativePath}/`, ...await collectTreeEntries(root, path));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`release archive contains unsupported entry: ${relativePath}`);
  }
  return result;
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reject(reason) {
  throw new Error(
    `disabled Cursor SDK release policy v${DISABLED_CURSOR_SDK_RELEASE_POLICY.schemaVersion} rejected ${reason}`,
  );
}
