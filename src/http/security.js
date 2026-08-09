import { randomBytes, timingSafeEqual } from "node:crypto";
import { ContractError } from "../core/contracts.js";

const ALLOWED_CORS_HEADERS = new Set(["authorization", "content-type", "idempotency-key"]);
const ALLOWED_CORS_METHODS = new Set(["GET", "POST"]);

export function createApiSecurity(options = {}) {
  const configuredToken = options.apiToken?.trim();
  const apiToken = configuredToken || randomBytes(32).toString("base64url");
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeConfiguredOrigin));
  const allowedHosts = new Set(options.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"]);

  return {
    apiToken,
    generatedToken: !configuredToken,

    validateHost(req, address) {
      const rawHost = req.headers.host;
      if (!rawHost) throw new ContractError("invalid_host", "Host header is required", 421);
      let host;
      try { host = new URL(`http://${rawHost}`); }
      catch { throw new ContractError("invalid_host", "Host header is invalid", 421); }
      const expectedPort = String(address?.port ?? options.port);
      const actualPort = host.port || "80";
      if (!allowedHosts.has(host.hostname) || actualPort !== expectedPort) {
        throw new ContractError("invalid_host", "Host header is not allowed", 421);
      }
      return host.origin;
    },

    validateOrigin(req, requestOrigin) {
      const rawOrigin = req.headers.origin;
      if (rawOrigin === undefined) return undefined;
      const origin = normalizeOrigin(rawOrigin);
      if (origin !== requestOrigin && !allowedOrigins.has(origin)) {
        throw new ContractError("origin_not_allowed", "request origin is not allowed", 403);
      }
      return origin;
    },

    applyCors(res, origin) {
      if (!origin) return;
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    },

    preflight(req, res, origin) {
      if (!origin) throw new ContractError("origin_required", "CORS preflight requires Origin", 403);
      const method = String(req.headers["access-control-request-method"] ?? "").toUpperCase();
      if (!ALLOWED_CORS_METHODS.has(method)) {
        throw new ContractError("cors_method_not_allowed", "CORS method is not allowed", 403);
      }
      const headers = String(req.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (headers.some((header) => !ALLOWED_CORS_HEADERS.has(header))) {
        throw new ContractError("cors_headers_not_allowed", "CORS headers are not allowed", 403);
      }
      this.applyCors(res, origin);
      res.setHeader("access-control-allow-methods", "GET, POST");
      res.setHeader("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key");
      res.setHeader("access-control-max-age", "600");
      res.writeHead(204);
      res.end();
    },

    authenticate(req, res) {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res.setHeader("www-authenticate", "Bearer");
        throw new ContractError("authentication_required", "Bearer token is required", 401);
      }
      const match = authorization.match(/^Bearer ([^\s]+)$/i);
      if (!match || !safeEqual(match[1], apiToken)) {
        res.setHeader("www-authenticate", 'Bearer error="invalid_token"');
        throw new ContractError("invalid_token", "Bearer token is invalid", 401);
      }
    },

    requireJson(req) {
      const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (type !== "application/json") {
        throw new ContractError("unsupported_media_type", "Content-Type must be application/json", 415);
      }
    },
  };
}

function normalizeConfiguredOrigin(value) {
  try { return normalizeOrigin(value); }
  catch (error) { throw new TypeError(`invalid allowed origin: ${value}`, { cause: error }); }
}

function normalizeOrigin(value) {
  if (value === "null") throw new ContractError("origin_not_allowed", "request origin is not allowed", 403);
  let url;
  try { url = new URL(value); }
  catch { throw new ContractError("origin_not_allowed", "request origin is invalid", 403); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new ContractError("origin_not_allowed", "request origin is invalid", 403);
  }
  return url.origin;
}

function safeEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  const comparable = actualBytes.length === expectedBytes.length
    ? actualBytes
    : Buffer.alloc(expectedBytes.length);
  return timingSafeEqual(comparable, expectedBytes) && actualBytes.length === expectedBytes.length;
}
