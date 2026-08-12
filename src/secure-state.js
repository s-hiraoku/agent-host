import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export async function ensurePrivateDirectory(path) {
  await ensureOwnedDirectory(path, { mode: 0o700, tighten: true });
}

export async function ensureOwnedDirectory(path, { mode = 0o700, tighten = false } = {}) {
  await mkdir(path, { recursive: true, mode });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`state directory must be a real directory: ${path}`);
  assertOwned(stat, path);
  if (tighten) await chmod(path, mode);
}

export async function readPrivateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`private state must be a regular file: ${path}`);
  assertOwned(stat, path);
  if ((stat.mode & 0o077) !== 0) await chmod(path, 0o600);
  return readFile(path, "utf8");
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
