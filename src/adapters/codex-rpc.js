import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 20_000;

export class CodexRpcClient {
  #command;
  #args;
  #env;
  #cwd;
  #proc;
  #reader;
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
    const proc = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc = proc;

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
    proc.stderr?.on("data", () => {});

    this.#reader = createInterface({ input: proc.stdout });
    this.#reader.on("line", (line) => this.#handleLine(line));
    this.#started = true;

    await this.request("initialize", {
      clientInfo: { name: "agent_host", title: "agent-host", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  async request(method, params, options = {}) {
    if (!this.#started && method !== "initialize") await this.start();
    const id = `ah-${this.#nextId++}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const message = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.#write(message); }
      catch (error) {
        clearTimeout(timer);
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

  async close() {
    this.#started = false;
    this.#reader?.close();
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
      for (const handler of this.#serverRequestHandlers) handler(message);
      return;
    }

    if (message.method) {
      for (const handler of this.#notificationHandlers) handler(message);
    }
  }
}
