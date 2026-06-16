import type { Message } from "@my-agent-team/message";

export interface Thread {
  readonly id: string;
  messages: Message[];
}

export function createThread(messages?: Message[], id?: string): Thread {
  return {
    id: id ?? crypto.randomUUID(),
    messages: messages ?? [],
  };
}
