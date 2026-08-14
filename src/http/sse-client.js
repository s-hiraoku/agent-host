export const MAX_SSE_PENDING_EVENTS = 64;
export const MAX_SSE_PENDING_BYTES = 256 * 1024;

export class SseClient {
  #response;
  #operations;
  #onClose;
  #onDepth;
  #maxEvents;
  #maxBytes;
  #pending = [];
  #pendingBytes = 0;
  #blocked = false;
  #closed = false;
  #onDrain;

  constructor(response, options = {}) {
    this.#response = response;
    this.#operations = options.operations;
    this.#onClose = options.onClose ?? (() => {});
    this.#onDepth = options.onDepth ?? (() => {});
    this.#maxEvents = options.maxEvents ?? MAX_SSE_PENDING_EVENTS;
    this.#maxBytes = options.maxBytes ?? MAX_SSE_PENDING_BYTES;
    this.#onDrain = () => this.#drain();
    response.on("drain", this.#onDrain);
    response.on("error", () => this.close());
    response.on("close", () => this.close());
  }

  send(payload, { heartbeat = false } = {}) {
    if (this.#closed) return false;
    if (!this.#blocked) {
      const writable = this.#response.write(payload);
      if (!writable) this.#blocked = true;
      return true;
    }
    if (heartbeat) return false;
    const bytes = Buffer.byteLength(payload);
    if (this.#pending.length >= this.#maxEvents || this.#pendingBytes + bytes > this.#maxBytes) {
      this.#operations?.metrics.increment("sse_overflows");
      this.#operations?.logger.log("warn", "sse.overflow", {
        component: "http", outcome: "failure", code: "queue_full",
        details: { pendingEvents: this.#pending.length, pendingBytes: this.#pendingBytes },
      });
      this.close();
      return false;
    }
    this.#pending.push(payload);
    this.#pendingBytes += bytes;
    this.#onDepth(this.#pending.length);
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#response.off("drain", this.#onDrain);
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#onDepth(0);
    if (!this.#response.writableEnded) this.#response.end();
    this.#onClose();
  }

  get closed() { return this.#closed; }
  get pendingEvents() { return this.#pending.length; }
  get pendingBytes() { return this.#pendingBytes; }

  #drain() {
    if (this.#closed) return;
    this.#blocked = false;
    while (this.#pending.length) {
      const payload = this.#pending.shift();
      this.#pendingBytes -= Buffer.byteLength(payload);
      const writable = this.#response.write(payload);
      this.#onDepth(this.#pending.length);
      if (!writable) {
        this.#blocked = true;
        break;
      }
    }
  }
}
