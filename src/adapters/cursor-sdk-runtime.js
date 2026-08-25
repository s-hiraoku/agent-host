import { dirname } from "node:path";
import { openAnchoredPrivateState } from "../anchored-private-state.js";
import {
  createCursorSdkFileCredentialSource,
  preflightCursorSdkCredentialFile,
} from "./cursor-sdk-credentials.js";
import { createCursorSdkBridgeClient } from "./cursor-sdk-transport.js";
import { CursorSdkAdapter } from "./cursor-sdk.js";

export class CursorSdkBridgeRuntimeAdapter {
  id = "cursor-sdk";
  discoveryHealth = "internal";
  #configuration;
  #adapter;
  #opening;
  #destroying;
  #destroyed = false;
  #listeners = new Set();
  #unsubscribe;

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
    await Promise.all([
      preflightCursorSdkCredentialFile(config.bearerTokenFile),
      preflightCursorSdkCredentialFile(config.apiKeyFile),
    ]);
    const bearerTokenSource = createCursorSdkFileCredentialSource(config.bearerTokenFile);
    const credentialSource = createCursorSdkFileCredentialSource(config.apiKeyFile);
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
      this.#unsubscribe = adapter.onChange?.((event) => {
        for (const listener of this.#listeners) {
          try { listener(event); }
          catch { /* registry listeners are isolated from the runtime transport */ }
        }
      });
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
  prepareLaunchRetirement(record, options) {
    return this.#required().prepareLaunchRetirement(record, options);
  }
  retireLaunch(record, options) { return this.#required().retireLaunch(record, options); }
  finalizeLaunchRetirement(retirement) {
    return this.#required().finalizeLaunchRetirement(retirement);
  }
  discoverOwned(records, options) { return this.#required().discoverOwned(records, options); }
  markStale(agent) { return this.#required().markStale(agent); }
  prompt(agent, text, options) { return this.#required().prompt(agent, text, options); }
  interrupt(agent, options) { return this.#required().interrupt(agent, options); }
  read(agent, options) { return this.#required().read(agent, options); }
  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close() {
    if (this.#destroyed) return;
    await this.#opening?.catch(() => {});
    await this.#adapter?.close();
  }

  destroy() {
    if (this.#destroying) return this.#destroying;
    if (this.#destroyed) return Promise.resolve();
    this.#destroyed = true;
    this.#destroying = (async () => {
      await this.#opening?.catch(() => {});
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      await this.#adapter?.destroy();
      this.#listeners.clear();
    })();
    return this.#destroying;
  }

  #required() {
    if (!this.#adapter) throw new Error("Cursor SDK Bridge runtime must be opened before use");
    return this.#adapter;
  }
}
