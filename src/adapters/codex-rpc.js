import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_BYTES = 4096;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export class CodexRpcClient {
  #command;
  #args;
  #env;
  #cwd;
  #spawn;
  #proc;
  #reader;
  #stderrTail = "";
  #pending = new Map();
  #nextId = 1;
  #notificationHandlers = new Set();
  #serverRequestHandlers = new Set();
  #started = false;
  #startPromise;

  constructor(options = {}) {
    this.#command = options.command ?? "codex";
    this.#args = options.args ?? ["app-server", "--listen", "stdio://"];
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

      proc.once("exit", (code, signal) => {
        this.#started = false;
        const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      });
      proc.stderr?.on("data", (chunk) => {
        this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
      });

      this.#reader = createInterface({ input: proc.stdout });
      this.#reader.on("line", (line) => this.#handleLine(line));
      this.#started = true;

      await this.request("initialize", {
        clientInfo: { name: "agent_host", title: "agent-host", version: PACKAGE_VERSION },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized");
    } catch (error) {
      const stderr = this.#stderrTail.trim();
      await this.close();
      const detail = stderr ? `\ncodex app-server stderr:\n${stderr}` : "";
      throw new Error(`${error?.message ?? error}${detail}`, { cause: error });
    }
  }

  async request(method, params, options = {}) {
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
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try { this.#write(message); }
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
    this.#started = false;
    this.#reader?.close();
    this.#reader = undefined;
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
    if (!this.#proc?.stdin?.writable) throw new Error("codex app-server is not writable");
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return; }

    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

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
}
