import type { Message } from "@my-agent-team/core";

export interface Checkpointer {
  load(threadId: string): Promise<Message[] | null>;
  save(threadId: string, messages: Message[]): Promise<void>;
}
