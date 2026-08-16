import { createHash } from "node:crypto";
import { ContractError } from "./contracts.js";

export const LAUNCH_SCHEMA_VERSION = 1;
export const LAUNCH_STATES = new Set(["requested", "creating", "owned", "failed", "uncertain"]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const REQUEST_KEYS = new Set(["provider", "target", "profile", "mode", "confirmations"]);
const CONFIRMATION_KEYS = new Set(["localMutation", "externalBillable"]);
const RECORD_KEYS = new Set([
  "id", "attemptId", "keyHash", "signature", "request", "state", "providerAgentId", "agentId", "error",
  "requestedAt", "updatedAt",
]);
const RESOLVED_REQUEST_KEYS = new Set(["provider", "target", "profile", "mode", "risk", "capabilityVersion"]);
const ERROR_KEYS = new Set(["code", "retryable"]);

export function normalizeLaunchCapabilities(rawProviders) {
  const providers = [];
  const seenProviders = new Set();
  for (const raw of rawProviders ?? []) {
    if (!raw || !safeId(raw.provider) || seenProviders.has(raw.provider)
      || !safeId(raw.capabilityVersion) || !Array.isArray(raw.targets)) continue;
    const targets = [];
    const seenTargets = new Set();
    for (const target of raw.targets.slice(0, 20)) {
      if (!target || !safeId(target.id) || seenTargets.has(target.id)
        || !Array.isArray(target.profiles) || !Array.isArray(target.modes)) continue;
      const profiles = [...new Set(target.profiles.filter(safeId))].slice(0, 20);
      const modes = [];
      const seenModes = new Set();
      for (const mode of target.modes.slice(0, 20)) {
        if (!mode || !safeId(mode.id) || seenModes.has(mode.id)
          || typeof mode.localMutation !== "boolean" || typeof mode.externalBillable !== "boolean") continue;
        seenModes.add(mode.id);
        modes.push({
          id: mode.id,
          enabled: mode.enabled === true,
          risk: { localMutation: mode.localMutation, externalBillable: mode.externalBillable },
        });
      }
      if (!profiles.length || !modes.length) continue;
      seenTargets.add(target.id);
      targets.push({ id: target.id, profiles, modes });
    }
    if (!targets.length) continue;
    seenProviders.add(raw.provider);
    providers.push({ provider: raw.provider, capabilityVersion: raw.capabilityVersion, targets });
  }
  return { version: String(LAUNCH_SCHEMA_VERSION), providers };
}

export function normalizeLaunchRequest(payload, capabilities) {
  if (!plainObject(payload) || Object.keys(payload).some((key) => !REQUEST_KEYS.has(key))) {
    throw new ContractError("invalid_launch_request", "launch request has unsupported fields");
  }
  for (const field of ["provider", "target", "profile", "mode"]) {
    if (!safeId(payload[field])) throw new ContractError("invalid_launch_request", `${field} must be a safe identifier`);
  }
  if (!plainObject(payload.confirmations)
    || Object.keys(payload.confirmations).some((key) => !CONFIRMATION_KEYS.has(key))
    || typeof payload.confirmations.localMutation !== "boolean"
    || typeof payload.confirmations.externalBillable !== "boolean") {
    throw new ContractError(
      "invalid_launch_confirmations",
      "confirmations must explicitly acknowledge localMutation and externalBillable",
    );
  }
  const provider = capabilities.providers.find((entry) => entry.provider === payload.provider);
  const target = provider?.targets.find((entry) => entry.id === payload.target);
  const mode = target?.modes.find((entry) => entry.id === payload.mode && entry.enabled);
  if (!provider || !target || !target.profiles.includes(payload.profile) || !mode) {
    throw new ContractError("launch_option_not_found", "launch option is not available", 404);
  }
  if (payload.confirmations.localMutation !== mode.risk.localMutation
    || payload.confirmations.externalBillable !== mode.risk.externalBillable) {
    throw new ContractError("launch_confirmation_mismatch", "confirmations do not match the selected mode", 409);
  }
  return {
    provider: provider.provider,
    target: target.id,
    profile: payload.profile,
    mode: mode.id,
    risk: { ...mode.risk },
    capabilityVersion: provider.capabilityVersion,
  };
}

export function validateIdempotencyKey(key) {
  if (!IDEMPOTENCY_KEY.test(key ?? "")) {
    throw new ContractError("invalid_idempotency_key", "Idempotency-Key must be 8-128 safe ASCII characters");
  }
  return key;
}

export function launchKeyHash(key) {
  return createHash("sha256").update(key).digest("base64url");
}

export function launchRequestSignature(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("base64url");
}

export function launchView(record) {
  return {
    id: record.id,
    provider: record.request.provider,
    target: record.request.target,
    profile: record.request.profile,
    mode: record.request.mode,
    risk: { ...record.request.risk },
    state: record.state,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.error ? { error: { code: record.error.code, retryable: record.error.retryable } } : {}),
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
  };
}

export function validateLaunchRecord(record) {
  if (!plainObject(record) || hasUnknownKeys(record, RECORD_KEYS)
    || !/^launch:[0-9a-f-]{36}$/.test(record.id) || !/^attempt:[0-9a-f-]{36}$/.test(record.attemptId)
    || !LAUNCH_STATES.has(record.state) || !safeHash(record.keyHash) || !safeHash(record.signature)
    || !plainObject(record.request) || hasUnknownKeys(record.request, RESOLVED_REQUEST_KEYS)
    || !safeId(record.request.provider) || !safeId(record.request.target)
    || !safeId(record.request.profile) || !safeId(record.request.mode)
    || !safeId(record.request.capabilityVersion) || !plainObject(record.request.risk)
    || hasUnknownKeys(record.request.risk, CONFIRMATION_KEYS)
    || typeof record.request.risk.localMutation !== "boolean"
    || typeof record.request.risk.externalBillable !== "boolean"
    || !validTimestamp(record.requestedAt) || !validTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.requestedAt)) return false;
  if (record.state === "owned") {
    if (!safeId(record.providerAgentId) || !safeId(record.agentId) || record.error !== undefined) return false;
  } else if (record.providerAgentId !== undefined || record.agentId !== undefined) return false;
  if (record.state === "failed" || record.state === "uncertain") {
    if (!plainObject(record.error) || hasUnknownKeys(record.error, ERROR_KEYS)
      || !safeId(record.error.code) || typeof record.error.retryable !== "boolean"
      || record.error.retryable !== (record.state === "uncertain")) return false;
  } else if (record.error !== undefined) return false;
  return true;
}

function safeId(value) { return typeof value === "string" && SAFE_ID.test(value); }
function safeHash(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function hasUnknownKeys(value, allowed) { return Object.keys(value).some((key) => !allowed.has(key)); }
