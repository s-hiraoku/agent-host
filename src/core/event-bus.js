import { EventEmitter } from "node:events";

export class AgentEventBus {
  #emitter = new EventEmitter();
  emit(event) { this.#emitter.emit("event", event); }
  subscribe(listener) {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
