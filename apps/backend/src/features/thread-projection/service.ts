import type { ThreadProjectionReadPort } from "./ports.js";

export function createThreadProjectionService(opts: { port: ThreadProjectionReadPort }) {
  return {
    async getMessages(threadId: string): Promise<unknown[]> {
      const msgs = await opts.port.getMessages(threadId);
      return msgs ?? [];
    },
  };
}

export type ThreadProjectionService = ReturnType<typeof createThreadProjectionService>;
