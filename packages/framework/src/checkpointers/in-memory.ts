import type { Message } from "@my-agent-team/message";
import type { CheckpointEventRow, Checkpointer, InterruptState } from "../checkpointer.js";

export function inMemoryCheckpointer(): Checkpointer {
  const messages = new Map<string, Message[]>();
  const interrupts = new Map<string, InterruptState>();
  const events = new Map<string, CheckpointEventRow[]>();

  return {
    async save(sessionId, msgs) {
      messages.set(sessionId, structuredClone([...msgs]));
    },
    async load(sessionId) {
      const found = messages.get(sessionId);
      return found ? structuredClone(found) : null;
    },

    async saveInterrupt(sessionId, state) {
      interrupts.set(sessionId, state);
    },
    async consumeInterrupt(sessionId) {
      const s = interrupts.get(sessionId);
      interrupts.delete(sessionId);
      return s ?? null;
    },

    async appendEvent(sessionId, spanId, event) {
      if (!events.has(sessionId)) events.set(sessionId, []);
      events.get(sessionId)?.push({ ...event, spanId: spanId ?? null, ts: event.ts });
    },
    async *readEvents(sessionId, opts) {
      const all = events.get(sessionId) ?? [];
      for (const e of all) {
        if (opts?.spanId && e.spanId !== opts.spanId) continue;
        yield e;
      }
    },

    async deleteThread(sessionId) {
      messages.delete(sessionId);
      interrupts.delete(sessionId);
      events.delete(sessionId);
    },
  };
}
