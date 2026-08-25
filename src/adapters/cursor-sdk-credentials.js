import { readStrictPrivateFileBufferBounded } from "../secure-state.js";
import { createCursorSdkCredentialSource } from "./cursor-sdk.js";

const MAX_CREDENTIAL_BYTES = 16_384;

export function createCursorSdkFileCredentialSource(path) {
  return createCursorSdkCredentialSource(async () => trimCredential(
    await readStrictPrivateFileBufferBounded(path, MAX_CREDENTIAL_BYTES + 1),
  ));
}

export async function preflightCursorSdkCredentialFile(path) {
  let bytes;
  try {
    bytes = await readStrictPrivateFileBufferBounded(path, MAX_CREDENTIAL_BYTES + 1);
    const { start, end } = credentialBounds(bytes);
    if (end - start < 8 || end - start > MAX_CREDENTIAL_BYTES) throw new Error("invalid credential");
  } catch (error) {
    throw Object.assign(new Error("Cursor SDK credential unavailable"), {
      code: "cursor_sdk_credential_unavailable",
      reason: credentialFailureReason(error),
    });
  } finally {
    bytes?.fill(0);
  }
}

function trimCredential(bytes) {
  const { start, end } = credentialBounds(bytes);
  if (start > 0) bytes.fill(0, 0, start);
  if (end < bytes.length) bytes.fill(0, end);
  return bytes.subarray(start, end);
}

function credentialBounds(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && whitespace(bytes[start])) start += 1;
  while (end > start && whitespace(bytes[end - 1])) end -= 1;
  return { start, end };
}

function credentialFailureReason(error) {
  if (error?.code === "ENOENT") return "credential_missing";
  const message = String(error?.message ?? "");
  if (message.includes("must not grant group or other access")) return "credential_permissions_insecure";
  if (message.includes("not owned by the current user")) return "credential_wrong_owner";
  if (message.includes("regular file")) return "credential_not_regular_file";
  return "credential_invalid";
}

function whitespace(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
}
