import type { ChatModel, Message } from "@my-agent-team/core";
import type { Logger } from "./logger.js";

export interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;
  model: ChatModel;
}

export interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}

export function pipeContextManagers(...managers: ContextManager[]): ContextManager {
  return {
    async shape(ctx, messages) {
      let current = [...messages];
      for (const m of managers) {
        current = await m.shape(ctx, current);
      }
      return current;
    },
  };
}
