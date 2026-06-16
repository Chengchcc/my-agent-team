import type { ContentBlock } from "@my-agent-team/core";
import type { MessageError, MessageRole, MessageState, MessageToolState } from "./message.js";

export interface MessageRevision {
  messageId: string;
  state: MessageState;
  role: MessageRole;
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolState[];
  runId?: string;
  conversationId?: string;
  visibility?: "internal" | "conversation";
  updatedAt: number;
  error?: MessageError;
}
