import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SseClient } from "../src/http/sse-client.js";

class FakeResponse extends EventEmitter {
  writes = [];
  writableEnded = false;
  writable = true;
  write(value) { this.writes.push(value); return this.writable; }
  end() { this.writableEnded = true; this.emit("close"); }
}

test("SSE client preserves FIFO after write(false) without duplicating the accepted event", () => {
  const response = new FakeResponse();
  const depths = [];
  const client = new SseClient(response, { onDepth: (depth) => depths.push(depth) });
  response.writable = false;
  client.send("one");
  client.send("two");
  client.send("three");
  client.send("heartbeat", { heartbeat: true });
  assert.deepEqual(response.writes, ["one"]);
  assert.equal(client.pendingEvents, 2);

  response.writable = true;
  response.emit("drain");
  assert.deepEqual(response.writes, ["one", "two", "three"]);
  assert.equal(client.pendingEvents, 0);
  assert.deepEqual(depths, [1, 2, 1, 0]);
  client.close();
  assert.equal(response.listenerCount("drain"), 0);
});

test("SSE client closes only the slow client at the event or byte bound", () => {
  const response = new FakeResponse();
  response.writable = false;
  let overflows = 0;
  const client = new SseClient(response, {
    maxEvents: 2,
    maxBytes: 8,
    operations: {
      metrics: { increment(name) { if (name === "sse_overflows") overflows += 1; } },
      logger: { log() {} },
    },
  });
  client.send("accepted");
  client.send("aa");
  client.send("bb");
  assert.equal(client.send("cc"), false);
  assert.equal(client.closed, true);
  assert.equal(response.writableEnded, true);
  assert.equal(overflows, 1);
});
