import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexRpcClient } from "../src/adapters/codex-rpc.js";

function fakeProcess(onMessage) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.killedWith = undefined;
  proc.kill = (signal) => {
    proc.killedWith = signal;
    proc.exitCode = 0;
    queueMicrotask(() => proc.emit("exit", 0, signal));
    return true;
  };

  let input = "";
  proc.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line) onMessage(proc, JSON.parse(line));
    }
  });
  queueMicrotask(() => proc.emit("spawn"));
  return proc;
}

test("Codex RPC cleans up failed startup and can start again", async () => {
  const processes = [];
  const initializations = [];
  const client = new CodexRpcClient({
    spawn() {
      const attempt = processes.length;
      const proc = fakeProcess((child, message) => {
        if (message.method !== "initialize") return;
        initializations.push(message.params.clientInfo);
        if (attempt === 0) {
          child.stderr.write("handshake diagnostic");
          child.stdout.write(`${JSON.stringify({ id: message.id, error: { message: "bad handshake" } })}\n`);
        } else {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      });
      processes.push(proc);
      return proc;
    },
  });

  await assert.rejects(client.start(), /bad handshake[\s\S]*handshake diagnostic/);
  assert.equal(processes[0].killedWith, "SIGTERM");
  await client.start();
  assert.equal(processes.length, 2);
  assert.equal(initializations[1].version, "0.2.0");
  await client.close();
});

test("Codex RPC isolates notification handler failures", async () => {
  let proc;
  const client = new CodexRpcClient({
    spawn() {
      proc = fakeProcess((child, message) => {
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      });
      return proc;
    },
  });
  await client.start();

  let received = 0;
  client.onNotification(() => { throw new Error("handler failed"); });
  client.onNotification(() => { received += 1; });
  proc.stdout.write(`${JSON.stringify({ method: "turn/started", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 1);
  await client.close();
});

test("Codex RPC cleans up AbortSignal listeners on success, error, and cancellation", async () => {
  const client = new CodexRpcClient({
    spawn() {
      return fakeProcess((child, message) => {
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === "thread/list") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
        } else if (message.method === "fail") {
          child.stdout.write(`${JSON.stringify({ id: message.id, error: { message: "failed" } })}\n`);
        }
      });
    },
  });
  await client.start();
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let additions = 0;
  let removals = 0;
  signal.addEventListener = (...args) => { additions += 1; return originalAdd(...args); };
  signal.removeEventListener = (...args) => { removals += 1; return originalRemove(...args); };

  await client.request("thread/list", {}, { signal, timeoutMs: 10_000 });
  await assert.rejects(client.request("fail", {}, { signal, timeoutMs: 10_000 }), /failed/);
  const request = client.request("hang", {}, { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(additions, 3);
  assert.equal(removals, 3);
  await client.close();
});
