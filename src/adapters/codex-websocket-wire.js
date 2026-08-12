import { createHash, randomBytes } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BYTES = 16 * 1024;

export class CodexWebSocketWire {
  #readable;
  #writable;
  #randomBytes;
  #maxPayloadBytes;
  #handshakeTimeoutMs;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentBytes = 0;
  #state = "idle";
  #key;
  #startResolve;
  #startReject;
  #timer;
  #onData;
  #onStreamError;
  #onReadableEnd;
  #onReadableClose;
  #onWritableClose;
  onMessage = () => {};
  onError = () => {};
  onClose = () => {};

  constructor(options) {
    this.#readable = options.readable;
    this.#writable = options.writable;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  start() {
    if (this.#state !== "idle") throw new Error("Codex websocket wire already started");
    this.#state = "handshake";
    this.#key = this.#randomBytes(16).toString("base64");
    this.#onData = (chunk) => this.#receive(Buffer.from(chunk));
    this.#onStreamError = (error) => this.#fail(error);
    this.#onReadableEnd = () => this.#fail(new Error("Codex websocket input ended"));
    this.#onReadableClose = () => this.#fail(new Error("Codex websocket input closed"));
    this.#onWritableClose = () => this.#fail(new Error("Codex websocket output closed"));
    this.#readable.on("data", this.#onData);
    this.#readable.once("error", this.#onStreamError);
    this.#readable.once("end", this.#onReadableEnd);
    this.#readable.once("close", this.#onReadableClose);
    this.#writable.once("error", this.#onStreamError);
    this.#writable.once("close", this.#onWritableClose);
    const promise = new Promise((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    this.#timer = setTimeout(
      () => this.#fail(new Error("Codex websocket handshake timed out")),
      this.#handshakeTimeoutMs,
    );
    this.#timer.unref?.();
    this.#writable.write([
      "GET / HTTP/1.1",
      "Host: localhost",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${this.#key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
    return promise;
  }

  send(text) {
    if (this.#state !== "open") throw new Error("Codex websocket wire is not open");
    this.#sendFrame(0x1, Buffer.from(text));
  }

  close() {
    const reject = this.#startReject;
    if (this.#state === "open") {
      try { this.#sendFrame(0x8, Buffer.alloc(0)); }
      catch {}
    }
    this.#finish();
    reject?.(new Error("Codex websocket wire closed during handshake"));
  }

  #receive(chunk) {
    if (this.#state === "closed") return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      if (this.#state === "handshake" && !this.#consumeHandshake()) return;
      if (this.#state === "open") this.#consumeFrames();
    } catch (error) {
      this.#fail(error);
    }
  }

  #consumeHandshake() {
    const boundary = this.#buffer.indexOf("\r\n\r\n");
    if ((boundary >= 0 && boundary + 4 > MAX_HANDSHAKE_BYTES)
      || (boundary < 0 && this.#buffer.length > MAX_HANDSHAKE_BYTES)) {
      throw new Error("Codex websocket handshake is too large");
    }
    if (boundary < 0) return false;
    const header = this.#buffer.subarray(0, boundary).toString("utf8");
    this.#buffer = this.#buffer.subarray(boundary + 4);
    const lines = header.split("\r\n");
    if (!/^HTTP\/1\.1 101(?:\s|$)/.test(lines.shift() ?? "")) {
      throw new Error("Codex websocket proxy rejected the upgrade");
    }
    const headers = new Map(lines.map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Codex websocket response header is invalid");
      return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
    }));
    const expected = createHash("sha1").update(`${this.#key}${WEBSOCKET_GUID}`).digest("base64");
    if (headers.get("sec-websocket-accept") !== expected) throw new Error("Codex websocket accept key is invalid");
    if (headers.has("sec-websocket-extensions")) throw new Error("Codex websocket extensions are not supported");
    if (headers.get("upgrade")?.toLowerCase() !== "websocket") throw new Error("Codex websocket upgrade header is invalid");
    if (!headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
      throw new Error("Codex websocket connection header is invalid");
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#state = "open";
    this.#startResolve?.();
    this.#startResolve = undefined;
    this.#startReject = undefined;
    return true;
  }

  #consumeFrames() {
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      if (first & 0x70) throw new Error("Codex websocket RSV bits are not supported");
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      if (second & 0x80) throw new Error("Codex websocket server frames must not be masked");
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const largeLength = this.#buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(this.#maxPayloadBytes)) throw new Error("Codex websocket payload is too large");
        length = Number(largeLength);
        offset = 10;
      }
      const isDataFrame = opcode === 0x0 || opcode === 0x1 || opcode === 0x2;
      if (length > this.#maxPayloadBytes
        || (isDataFrame && this.#fragmentBytes + length > this.#maxPayloadBytes)) {
        throw new Error("Codex websocket payload is too large");
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      this.#handleFrame(opcode, fin, payload);
      if (this.#state !== "open") return;
    }
  }

  #handleFrame(opcode, fin, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new Error("Codex websocket control frame is invalid");
      if (opcode === 0x8) {
        try { this.#sendFrame(0x8, payload); }
        catch {}
        this.#finish();
        this.onClose();
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xA, payload);
        return;
      }
      if (opcode === 0xA) return;
      throw new Error("Codex websocket control opcode is unsupported");
    }
    if (opcode === 0x2) throw new Error("Codex websocket binary frames are not supported");
    if (opcode === 0x1) {
      if (this.#fragments.length) throw new Error("Codex websocket text fragments overlap");
      this.#fragments.push(payload);
      this.#fragmentBytes = payload.length;
    } else if (opcode === 0x0) {
      if (!this.#fragments.length) throw new Error("Codex websocket continuation has no initial frame");
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
    } else {
      throw new Error("Codex websocket data opcode is unsupported");
    }
    if (!fin) return;
    const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.onMessage(new TextDecoder("utf-8", { fatal: true }).decode(message));
  }

  #sendFrame(opcode, payload) {
    const mask = this.#randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
    this.#writable.write(Buffer.concat([header, mask, masked]));
  }

  #fail(error) {
    if (this.#state === "closed") return;
    const reject = this.#startReject;
    this.#finish();
    reject?.(error);
    this.onError(error);
  }

  #finish() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#onData) this.#readable.off("data", this.#onData);
    if (this.#onStreamError) {
      this.#readable.off("error", this.#onStreamError);
      this.#writable.off("error", this.#onStreamError);
    }
    if (this.#onReadableEnd) this.#readable.off("end", this.#onReadableEnd);
    if (this.#onReadableClose) this.#readable.off("close", this.#onReadableClose);
    if (this.#onWritableClose) this.#writable.off("close", this.#onWritableClose);
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#buffer = Buffer.alloc(0);
    this.#fragments = [];
    this.#fragmentBytes = 0;
  }
}
