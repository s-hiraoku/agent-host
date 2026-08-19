import { dirname } from "node:path";
import { openAnchoredPrivateState } from "../anchored-private-state.js";
import { readPrivateFileBufferBounded } from "../secure-state.js";
import { createCursorSdkBridgeClient } from "./cursor-sdk-transport.js";
import { CursorSdkAdapter, createCursorSdkCredentialSource } from "./cursor-sdk.js";

const MAX_CREDENTIAL_BYTES = 16_384;

export class CursorSdkBridgeRuntimeAdapter {
  id = "cursor-sdk";
  discoveryHealth = "internal";
  #configuration;
  #adapter;
  #opening;
  #destroying;
  #destroyed = false;

  constructor(configuration) {
    if (!configuration || typeof configuration !== "object") {
      throw new TypeError("cursorSdkBridge configuration is required");
    }
    this.#configuration = configuration;
  }

  async open() {
    if (this.#destroyed) throw new Error("Cursor SDK Bridge runtime is destroyed");
    if (this.#adapter) return this.#adapter.open();
    if (this.#opening) return this.#opening;
    this.#opening = this.#create();
    try { await this.#opening; }
    finally { this.#opening = undefined; }
  }

  async #create() {
    const config = this.#configuration;
    const bearerTokenSource = fileCredentialSource(config.bearerTokenFile);
    const credentialSource = fileCredentialSource(config.apiKeyFile);
    let bridge;
    let privateState;
    let adapter;
    try {
      bridge = createCursorSdkBridgeClient({
        endpoint: config.endpoint,
        sdkVersion: config.sdkVersion,
        bearerTokenSource,
        timeoutMs: config.timeoutMs,
      });
      privateState = await openAnchoredPrivateState(dirname(config.provenanceFile), {
        helperPath: config.helperPath,
      });
      adapter = new CursorSdkAdapter({
        bridge,
        credentialSource,
        sdkVersion: config.sdkVersion,
        storeDirectory: config.storeDirectory,
        provenanceFile: config.provenanceFile,
        targets: config.targets,
        privateState,
      });
      await adapter.open();
      if (this.#destroyed) {
        await adapter.destroy();
        throw new Error("Cursor SDK Bridge runtime is destroyed");
      }
      this.#adapter = adapter;
    } catch (error) {
      if (adapter) await adapter.destroy().catch(() => {});
      else {
        await privateState?.dispose?.().catch(() => {});
        await bridge?.destroy?.().catch(() => {});
      }
      throw error;
    }
  }

  launchCapabilities() { return this.#adapter?.launchCapabilities() ?? null; }
  discover(options) { return this.#adapter?.discover(options) ?? []; }
  launch(request, options) { return this.#required().launch(request, options); }
  reconcileLaunch(record, options) { return this.#required().reconcileLaunch(record, options); }
  discoverOwned(records, options) { return this.#required().discoverOwned(records, options); }
  markStale(agent) { return this.#required().markStale(agent); }

  async close() {
    if (this.#destroyed) return;
    await this.#opening;
    await this.#adapter?.close();
  }

  destroy() {
    if (this.#destroying) return this.#destroying;
    if (this.#destroyed) return Promise.resolve();
    this.#destroyed = true;
    this.#destroying = (async () => {
      await this.#opening?.catch(() => {});
      await this.#adapter?.destroy();
    })();
    return this.#destroying;
  }

  #required() {
    if (!this.#adapter) throw new Error("Cursor SDK Bridge runtime must be opened before use");
    return this.#adapter;
  }
}

function fileCredentialSource(path) {
  return createCursorSdkCredentialSource(async () => {
    const bytes = await readPrivateFileBufferBounded(path, MAX_CREDENTIAL_BYTES + 1);
    let start = 0;
    let end = bytes.length;
    while (start < end && whitespace(bytes[start])) start += 1;
    while (end > start && whitespace(bytes[end - 1])) end -= 1;
    if (start > 0) bytes.fill(0, 0, start);
    if (end < bytes.length) bytes.fill(0, end);
    return bytes.subarray(start, end);
  });
}

function whitespace(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
}
