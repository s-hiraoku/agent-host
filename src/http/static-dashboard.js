import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MEDIA_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

export function createStaticDashboard(directory, fileSystem = { lstat, open, realpath }) {
  if (!directory) return undefined;
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("static dashboard serving requires O_NOFOLLOW support");
  const root = resolve(directory);
  return async function serveStaticDashboard(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { return false; }
    if (decoded.includes("\0") || decoded.split("/").includes("..")) return false;
    const requested = decoded === "/" || !extname(decoded) ? "index.html" : decoded.slice(1);
    const path = resolve(root, requested);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return false;
    let file;
    let body;
    try {
      const stat = await fileSystem.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const realPath = await fileSystem.realpath(path);
      const realRoot = await fileSystem.realpath(root);
      if (!realPath.startsWith(`${realRoot}${sep}`)) return false;
      file = await fileSystem.open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await file.stat();
      if (!opened.isFile()) return false;
      body = await file.readFile();
    }
    catch (error) {
      if (["EISDIR", "ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code)) return false;
      throw error;
    }
    finally {
      await file?.close();
    }
    const extension = extname(path).toLowerCase();
    if (!MEDIA_TYPES.has(extension)) return false;
    const immutable = /(?:[.-])[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
    res.writeHead(200, {
      "content-type": MEDIA_TYPES.get(extension) ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": extension === ".html"
        ? "no-store"
        : immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  };
}
