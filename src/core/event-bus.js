import { EventEmitter } from "node:events";

export class AgentEventBus {
  #emitter = new EventEmitter();
  #sequence = 0;

  get sequence() { return this.#sequence; }

  emit(event) {
    const sequenced = { ...event, sequence: ++this.#sequence };
    this.#emitter.emit("event", sequenced);
    return sequenced;
  }
  subscribe(listener) {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
