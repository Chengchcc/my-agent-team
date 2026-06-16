import type { Message } from "@my-agent-team/message";
import type { CheckpointEvent, Checkpointer, InterruptState } from "../checkpointer.js";

export function inMemoryCheckpointer(): Checkpointer {
  const messages = new Map<string, Message[]>();
  const interrupts = new Map<string, InterruptState>();
  const events = new Map<string, CheckpointEvent[]>();

  return {
    async save(id, msgs) {
      messages.set(id, structuredClone([...msgs]));
    },
    async load(id) {
      const found = messages.get(id);
      return found ? structuredClone(found) : null;
    },

    async saveInterrupt(id, state) {
      interrupts.set(id, state);
    },
    async consumeInterrupt(id) {
      const s = interrupts.get(id);
      interrupts.delete(id);
      return s ?? null;
    },

    async appendEvent(id, event) {
      if (!events.has(id)) events.set(id, []);
      events.get(id)?.push(event);
    },
    async *readEvents(id) {
      yield* events.get(id) ?? [];
    },
  };
}
