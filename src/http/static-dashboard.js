import { lstat, readFile, realpath } from "node:fs/promises";
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

export function createStaticDashboard(directory) {
  if (!directory) return undefined;
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
    let body;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const realPath = await realpath(path);
      const realRoot = await realpath(root);
      if (!realPath.startsWith(`${realRoot}${sep}`)) return false;
      body = await readFile(realPath);
    }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return false;
      throw error;
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
