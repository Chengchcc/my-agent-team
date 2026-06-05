import type { Message } from "@my-agent-team/core";

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
