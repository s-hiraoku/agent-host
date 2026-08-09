import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { CodexWebSocketWire } from "../src/adapters/codex-websocket-wire.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(opcode, payload, fin = true) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function decodeClientFrame(frame) {
  const length = frame[1] & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = frame.subarray(6, 6 + length);
  return {
    opcode: frame[0] & 0x0f,
    masked: Boolean(frame[1] & 0x80),
    payload: Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])).toString(),
  };
}

function fixture(options = {}) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const writes = [];
  toServer.on("data", (chunk) => writes.push(Buffer.from(chunk)));
  const wire = new CodexWebSocketWire({
    readable: fromServer,
    writable: toServer,
    randomBytes: (length) => Buffer.alloc(length, 7),
    handshakeTimeoutMs: 1_000,
    ...options,
  });
  return { wire, fromServer, writes };
}

async function open(target) {
  const started = target.wire.start();
  await new Promise((resolve) => setImmediate(resolve));
  const request = target.writes.shift().toString();
  const key = request.match(/Sec-WebSocket-Key: (.+)\r\n/)?.[1];
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
  target.fromServer.write(response.slice(0, 40));
  target.fromServer.write(response.slice(40));
  await started;
}

test("Codex websocket proxy wire validates upgrade and exchanges framed JSON", async () => {
  const target = fixture();
  await open(target);
  const received = [];
  target.wire.onMessage = (message) => received.push(message);
  const first = serverFrame(0x1, '{"method":', false);
  target.fromServer.write(first.subarray(0, 1));
  target.fromServer.write(Buffer.concat([
    first.subarray(1), serverFrame(0x0, '"ready"}'), serverFrame(0x9, "ping"),
  ]));
  assert.deepEqual(received, ['{"method":"ready"}']);
  assert.deepEqual(decodeClientFrame(target.writes.shift()), { opcode: 0xA, masked: true, payload: "ping" });

  target.wire.send('{"method":"thread/list"}');
  assert.deepEqual(decodeClientFrame(target.writes.shift()), {
    opcode: 0x1,
    masked: true,
    payload: '{"method":"thread/list"}',
  });
  target.wire.close();
});

test("Codex websocket proxy wire rejects invalid handshakes and oversized payloads", async () => {
  const invalid = fixture();
  const failed = invalid.wire.start();
  await new Promise((resolve) => setImmediate(resolve));
  invalid.fromServer.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n");
  await assert.rejects(failed, /accept key is invalid/);

  const oversized = fixture({ maxPayloadBytes: 4 });
  await open(oversized);
  const errored = new Promise((resolve) => { oversized.wire.onError = resolve; });
  oversized.fromServer.write(serverFrame(0x1, "12345"));
  assert.match((await errored).message, /payload is too large/);
});

test("Codex websocket proxy wire accepts a small handshake coalesced with large frames", async () => {
  const target = fixture();
  const started = target.wire.start();
  await new Promise((resolve) => setImmediate(resolve));
  const request = target.writes.shift().toString();
  const key = request.match(/Sec-WebSocket-Key: (.+)\r\n/)?.[1];
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const messages = [];
  target.wire.onMessage = (message) => messages.push(message.length);
  target.fromServer.write(Buffer.concat([
    response,
    serverFrame(0x1, "x".repeat(20_000)),
    serverFrame(0x1, "y".repeat(70_000)),
  ]));
  await started;
  assert.deepEqual(messages, [20_000, 70_000]);
  target.wire.close();
});

test("Codex websocket proxy wire treats stream EOF as transport failure", async () => {
  const target = fixture();
  await open(target);
  const errored = new Promise((resolve) => { target.wire.onError = resolve; });
  target.fromServer.end();
  assert.match((await errored).message, /input ended/);
});
