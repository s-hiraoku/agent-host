import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const MAX_PRIVATE_REPORT_BYTES = 4 * 1024;

export async function validatePrivateReportDestination(path, {
  exactPaths = [],
  directoryPaths = [],
  inspect = lstat,
} = {}) {
  const destination = resolve(path);
  const parentPath = dirname(destination);
  const parent = await inspect(parentPath);
  assertOwnedReal(parent, "directory");
  const canonicalDestination = join(await realpath(parentPath), basename(destination));
  const canonicalExactPaths = await Promise.all(exactPaths.filter(Boolean).map(canonicalPath));
  const canonicalDirectoryPaths = await Promise.all(directoryPaths.filter(Boolean).map(canonicalPath));
  if (canonicalExactPaths.includes(canonicalDestination)
    || canonicalDirectoryPaths.some((entry) => inside(entry, canonicalDestination))) {
    throw new Error("report destination overlaps protected state");
  }
  let target;
  try { target = await inspect(destination); }
  catch (error) {
    if (error?.code === "ENOENT") return destination;
    throw error;
  }
  assertOwnedReal(target, "file");
  return destination;
}

async function canonicalPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try { return join(await realpath(cursor), ...suffix); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function serializePrivateReport(report) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_REPORT_BYTES) {
    throw new Error("private report exceeds its size limit");
  }
  return serialized;
}

function inside(directory, destination) {
  const child = relative(directory, destination);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function assertOwnedReal(stat, type) {
  const correctType = type === "directory" ? stat.isDirectory() : stat.isFile();
  if (!correctType || stat.isSymbolicLink()) throw new Error(`report destination must use a real ${type}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("report destination must be owned by the current user");
}
