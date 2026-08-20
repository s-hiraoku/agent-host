import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export async function ensurePrivateDirectory(path) {
  await ensureOwnedDirectory(path, { mode: 0o700, tighten: true });
}

export async function ensureOwnedDirectory(path, { mode = 0o700, tighten = false } = {}) {
  let existed = true;
  try { await lstat(path); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
  }
  await mkdir(path, { recursive: true, mode });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`state directory must be a real directory: ${path}`);
  assertOwned(stat, path);
  if (tighten && (stat.mode & 0o077) !== 0) {
    if (existed) throw new Error(`state directory must not grant group or other access: ${path}`);
    await chmod(path, mode);
  }
}

export async function readPrivateFile(path) {
  const { handle } = await openPrivateFile(path);
  try { return await handle.readFile("utf8"); }
  finally { await handle.close(); }
}

export async function readPrivateFileBounded(path, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  const { handle, stat } = await openPrivateFile(path);
  try {
    if (stat.size > maxBytes) throw new Error("private state exceeds its size limit");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readPrivateFileBufferBounded(path, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  const { handle, stat } = await openPrivateFile(path);
  try {
    if (stat.size > maxBytes) throw new Error("private state exceeds its size limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readStrictPrivateFileBufferBounded(path, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  const { handle, stat } = await openPrivateFile(path, { tighten: false });
  try {
    if (stat.size > maxBytes) throw new Error("private state exceeds its size limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readPrivateFileTail(path, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  const { handle, stat } = await openPrivateFile(path);
  const length = Math.min(stat.size, maxBytes);
  const offset = Math.max(0, stat.size - length);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const newline = content.indexOf("\n");
      content = newline === -1 ? "" : content.slice(newline + 1);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function openPrivateFile(path, { tighten = true } = {}) {
  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    const pathStat = await lstat(path);
    if (!stat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error(`private state must be a regular file: ${path}`);
    }
    assertOwned(stat, path);
    if ((stat.mode & 0o077) !== 0) {
      if (!tighten) throw new Error(`private state must not grant group or other access: ${path}`);
      await handle.chmod(0o600);
    }
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "ELOOP" || error?.code === "EMLINK") {
      throw new Error(`private state must be a regular file: ${path}`);
    }
    throw error;
  }
}

export async function writePrivateFileAtomic(path, content, { tightenDirectory = true } = {}) {
  const directory = dirname(path);
  await ensureOwnedDirectory(directory, { mode: 0o700, tighten: tightenDirectory });
  await assertSafeDestination(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readOrCreateToken(path) {
  try {
    const token = (await readPrivateFile(path)).trim();
    if (!token) throw new Error(`token file is empty: ${path}`);
    return token;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = generateToken();
  await writePrivateFileAtomic(path, `${token}\n`);
  return token;
}

export async function rotateToken(path) {
  const token = generateToken();
  await writePrivateFileAtomic(path, `${token}\n`);
  return token;
}

export function generateToken() {
  return randomBytes(32).toString("base64url");
}

function assertOwned(stat, path) {
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`private state must be owned by the current user: ${path}`);
  }
}

async function assertSafeDestination(path) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`private state must be a regular file: ${path}`);
  }
  assertOwned(stat, path);
}
