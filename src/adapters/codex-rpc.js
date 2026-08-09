import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CodexWebSocketWire } from "./codex-websocket-wire.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_BYTES = 4096;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export class CodexRpcClient {
  #command;
  #args;
  #env;
  #cwd;
  #spawn;
  #transport;
  #proc;
  #reader;
  #wire;
  #writer;
  #stderrTail = "";
  #pending = new Map();
  #nextId = 1;
  #notificationHandlers = new Set();
  #serverRequestHandlers = new Set();
  #stateHandlers = new Set();
  #started = false;
  #startPromise;
  #generation = 0;
  #initializationResult;

  constructor(options = {}) {
    this.#command = options.command ?? "codex";
    this.#transport = options.transport ?? "stdio";
    this.#args = options.args ?? (this.#transport === "control"
      ? ["app-server", "proxy", "--sock", options.socketPath]
      : ["app-server", "--listen", "stdio://"]);
    this.#env = options.env ?? process.env;
    this.#cwd = options.cwd;
    this.#spawn = options.spawn ?? spawn;
  }

  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  onServerRequest(handler) {
    this.#serverRequestHandlers.add(handler);
    return () => this.#serverRequestHandlers.delete(handler);
  }

  onStateChange(handler) {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  get generation() { return this.#generation; }
  get initializationResult() { return this.#initializationResult; }

  async start() {
    if (this.#started) return;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startInternal();
    try { await this.#startPromise; }
    finally { this.#startPromise = undefined; }
  }

  async #startInternal() {
    const proc = this.#spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc = proc;

    this.#stderrTail = "";

    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const cleanup = () => {
          proc.off("spawn", onSpawn);
          proc.off("error", onError);
        };
        proc.once("spawn", onSpawn);
        proc.once("error", onError);
      });

      const generation = this.#generation + 1;
      this.#generation = generation;
      proc.once("exit", (code, signal) => this.#disconnect(
        generation,
        new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`),
      ));
      proc.stderr?.on("data", (chunk) => {
        this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
      });

      if (this.#transport === "control") {
        const wire = new CodexWebSocketWire({ readable: proc.stdout, writable: proc.stdin });
        wire.onMessage = (message) => this.#handleLine(message, generation);
        wire.onError = (error) => this.#transportFailed(proc, generation, error);
        wire.onClose = () => this.#transportFailed(proc, generation, new Error("Codex control socket closed"));
        this.#wire = wire;
        await wire.start();
        this.#writer = (message) => wire.send(JSON.stringify(message));
      } else {
        this.#reader = createInterface({ input: proc.stdout });
        this.#reader.on("line", (line) => this.#handleLine(line, generation));
        this.#writer = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);
      }
      this.#started = true;

      this.#initializationResult = await this.request("initialize", {
        clientInfo: { name: "agent_host", title: "agent-host", version: PACKAGE_VERSION },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized");
      this.#emitState({ state: "connected", generation, initialization: this.#initializationResult });
    } catch (error) {
      const stderr = this.#stderrTail.trim();
      await this.close();
      const detail = stderr ? `\ncodex app-server stderr:\n${stderr}` : "";
      throw new Error(`${error?.message ?? error}${detail}`, { cause: error });
    }
  }

  async request(method, params, options = {}) {
    if (options.expectedGeneration !== undefined
      && (!this.#started || this.#generation !== options.expectedGeneration)) {
      throw new Error(`Codex connection generation ${options.expectedGeneration} is no longer active`);
    }
    if (!this.#started && method !== "initialize") await this.start();
    options.signal?.throwIfAborted();
    const id = `ah-${this.#nextId++}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const message = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.#pending.delete(id);
        cleanup();
        reject(options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        generation: this.#generation,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (options.expectedGeneration !== undefined
          && (!this.#started || this.#generation !== options.expectedGeneration)) {
          throw new Error(`Codex connection generation ${options.expectedGeneration} is no longer active`);
        }
        this.#write(message);
      }
      catch (error) {
        cleanup();
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    this.#write({ id, error });
  }

  async close() {
    const generation = this.#generation;
    this.#reader?.close();
    this.#reader = undefined;
    this.#wire?.close();
    this.#wire = undefined;
    this.#writer = undefined;
    this.#disconnect(generation, new Error("Codex RPC client closed"));
    const proc = this.#proc;
    this.#proc = undefined;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, 1000);
      timer.unref?.();
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  #write(message) {
    if (!this.#writer) throw new Error("codex app-server is not writable");
    this.#writer(message);
  }

  #handleLine(line, generation) {
    if (generation !== this.#generation) return;
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return; }

    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(String(message.id));
      if (!pending || pending.generation !== generation) return;
      this.#pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    Object.defineProperty(message, "connectionGeneration", { value: generation, enumerable: false });

    if (message.id !== undefined && message.method) {
      for (const handler of this.#serverRequestHandlers) this.#safeInvoke(handler, message);
      return;
    }

    if (message.method) {
      for (const handler of this.#notificationHandlers) this.#safeInvoke(handler, message);
    }
  }

  #safeInvoke(handler, message) {
    try { handler(message); }
    catch {}
  }

  #transportFailed(proc, generation, error) {
    this.#disconnect(generation, error);
    if (proc.exitCode === null) proc.kill("SIGTERM");
  }

  #disconnect(generation, error) {
    if (generation !== this.#generation) return;
    const wasConnected = this.#started;
    this.#reader?.close();
    this.#reader = undefined;
    this.#wire?.close();
    this.#wire = undefined;
    this.#started = false;
    this.#initializationResult = undefined;
    this.#writer = undefined;
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      this.#pending.delete(id);
      pending.reject(error);
    }
    if (wasConnected) this.#emitState({ state: "disconnected", generation, error });
  }

  #emitState(event) {
    for (const handler of this.#stateHandlers) this.#safeInvoke(handler, event);
  }
}
