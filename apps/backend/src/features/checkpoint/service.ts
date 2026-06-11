import type { CheckpointReadPort } from "./ports.js";

export function createCheckpointService(opts: { port: CheckpointReadPort }) {
  return {
    async getMessages(threadId: string): Promise<unknown[]> {
      const msgs = await opts.port.getMessages(threadId);
      return msgs ?? [];
    },
  };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;
