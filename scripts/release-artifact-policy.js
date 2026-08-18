import { execFile } from "node:child_process";
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
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (isCursorSdkPackage(name)) reject(`source manifest ${field} contains ${name}`);
    }
  }
  for (const name of manifest.bundledDependencies ?? manifest.bundleDependencies ?? []) {
    if (isCursorSdkPackage(name)) reject(`source manifest bundledDependencies contains ${name}`);
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

export async function verifyDisabledCursorSdkArchive(archive) {
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
    assertDisabledCursorSdkArtifactPaths(archiveEntries, "final archive index");
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

function isCursorSdkPackage(name) {
  return name === "@cursor/sdk" || name.startsWith("@cursor/sdk-");
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
    if (entry.isDirectory()) result.push(relativePath, ...await collectTreeEntries(root, path));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`release archive contains unsupported entry: ${relativePath}`);
  }
  return result;
}

function reject(reason) {
  throw new Error(
    `disabled Cursor SDK release policy v${DISABLED_CURSOR_SDK_RELEASE_POLICY.schemaVersion} rejected ${reason}`,
  );
}
