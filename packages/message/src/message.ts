import type { ContentBlock } from "./content-block.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageState = "pending" | "streaming" | "waiting" | "done" | "error";

export interface MessageAuthor {
  kind: "system" | "user" | "agent" | "tool";
  id?: string;
  displayName?: string;
}

export interface MessageToolState {
  id: string;
  name: string;
  state: "running" | "done" | "error";
  isError?: boolean;
}

export interface MessageError {
  code?: string;
  message: string;
}

export interface Message {
  id?: string;
  role: MessageRole;
  author?: MessageAuthor;
  state?: MessageState;
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolState[];
  runId?: string;
  conversationId?: string;
  visibility?: "internal" | "conversation";
  createdAt?: number;
  updatedAt?: number;
  error?: MessageError;
}
