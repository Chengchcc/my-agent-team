import { EventEmitter } from "node:events";
import type { EventRecord } from "@my-agent-team/event-log";

/** In-process pub/sub for low-latency event notification within a single backend instance. */
export class RunEventBus {
  #emitter = new EventEmitter();

  emit(record: EventRecord): void {
    this.#emitter.emit(`run:${record.runId}`, record);
  }

  on(runId: string, handler: (record: EventRecord) => void): () => void {
    const event = `run:${runId}`;
    this.#emitter.on(event, handler);
    return () => this.#emitter.off(event, handler);
  }

  removeAllListeners(runId: string): void {
    this.#emitter.removeAllListeners(`run:${runId}`);
  }
}
