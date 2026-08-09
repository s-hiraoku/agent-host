import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { CodexRpcClient } from "../src/adapters/codex-rpc.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { AgentRegistry } from "../src/core/registry.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

function serverFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function fakeControlProcess(onMessage) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.kill = (signal) => {
    proc.exitCode = 0;
    queueMicrotask(() => proc.emit("exit", 0, signal));
    return true;
  };
  let input = Buffer.alloc(0);
  let upgraded = false;
  proc.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    if (!upgraded) {
      const boundary = input.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const request = input.subarray(0, boundary).toString();
      input = input.subarray(boundary + 4);
      const key = request.match(/Sec-WebSocket-Key: (.+)\r\n/i)?.[1];
      const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      proc.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
    }
    while (input.length >= 6) {
      let length = input[1] & 0x7f;
      assert.ok(input[1] & 0x80, "client frames must be masked");
      let offset = 2;
      if (length === 126) {
        if (input.length < 8) return;
        length = input.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (input.length < 14) return;
        length = Number(input.readBigUInt64BE(2));
        offset = 10;
      }
      if (input.length < offset + 4 + length) return;
      const mask = input.subarray(offset, offset + 4);
      const payload = Buffer.from(input.subarray(offset + 4, offset + 4 + length));
      input = input.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if ((payload[0] ?? 0) === 0) continue;
      onMessage(proc, JSON.parse(payload.toString()));
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

test("Codex RPC connects through the explicit control socket and scopes messages to a connection generation", async () => {
  const processes = [];
  const states = [];
  const notifications = [];
  const spawnCalls = [];
  const client = new CodexRpcClient({
    transport: "control",
    socketPath: "/tmp/codex-control.sock",
    spawn(command, args) {
      spawnCalls.push({ command, args });
      const proc = fakeControlProcess((child, message) => {
        if (message.method === "initialize") child.stdout.write(serverFrame({ id: message.id, result: { userAgent: "fixture" } }));
      });
      processes.push(proc);
      return proc;
    },
  });
  client.onStateChange((event) => states.push(event));
  client.onNotification((message) => notifications.push(message));

  await client.start();
  assert.deepEqual(spawnCalls[0], {
    command: "codex",
    args: ["app-server", "proxy", "--sock", "/tmp/codex-control.sock"],
  });
  assert.equal(client.generation, 1);
  assert.equal(client.initializationResult.userAgent, "fixture");
  assert.equal(states.at(-1).state, "connected");

  processes[0].stdout.write(serverFrame({ method: "thread/status/changed", params: { threadId: "old" } }));
  assert.equal(notifications[0].connectionGeneration, 1);
  processes[0].exitCode = 1;
  processes[0].emit("exit", 1, null);
  assert.equal(states.at(-1).state, "disconnected");

  await client.start();
  assert.equal(client.generation, 2);
  processes[0].stdout.write(serverFrame({ method: "thread/status/changed", params: { threadId: "ignored" } }));
  processes[1].stdout.write(serverFrame({ method: "thread/status/changed", params: { threadId: "new" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications.map((message) => message.params.threadId), ["old", "new"]);
  assert.equal(notifications.at(-1).connectionGeneration, 2);
  await client.close();
});

test("Codex RPC rejects generation-bound requests after proxy EOF", async () => {
  let proc;
  let firstProc;
  let spawnAttempt = 0;
  const states = [];
  const client = new CodexRpcClient({
    transport: "control",
    socketPath: "/tmp/codex-control.sock",
    spawn() {
      spawnAttempt += 1;
      proc = fakeControlProcess((child, message) => {
        if (message.method === "initialize") child.stdout.write(serverFrame(spawnAttempt === 1
          ? { id: message.id, result: {} }
          : { id: message.id, error: { message: "fixture reconnect unavailable" } }));
        if (message.method === "thread/loaded/list") {
          child.stdout.write(serverFrame({ id: message.id, result: { data: ["thr_live"], nextCursor: null } }));
        }
        if (message.method === "thread/resume") {
          child.stdout.write(serverFrame({ id: message.id, result: { thread: {
            id: "thr_live", status: { type: "idle" }, canAcceptDirectInput: true,
          } } }));
        }
        if (message.method === "thread/list") {
          child.stdout.write(serverFrame({ id: message.id, result: { data: [{
            id: "thr_live", status: { type: "idle" }, canAcceptDirectInput: true,
          }], nextCursor: null } }));
        }
      });
      if (spawnAttempt === 1) {
        proc.kill = () => true;
        firstProc = proc;
      }
      return proc;
    },
  });
  client.onStateChange((event) => states.push(event));
  const registry = new AgentRegistry([new CodexAdapter({ mode: "control", client })]);
  await registry.refresh();
  assert.equal(registry.get("codex:thr_live").capabilities.prompt, true);
  firstProc.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).state, "disconnected");
  assert.equal(registry.get("codex:thr_live").status, "unknown");
  assert.equal(Object.values(registry.get("codex:thr_live").capabilities).some(Boolean), false);
  await assert.rejects(
    client.request("turn/start", {}, { expectedGeneration: 1 }),
    /generation 1 is no longer active/,
  );
  firstProc.exitCode = 0;
  proc.exitCode = 0;
  await registry.close();
});
