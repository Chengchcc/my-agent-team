import type { ContentBlock } from "./content-block.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageState = "pending" | "streaming" | "waiting" | "done" | "error";

/** Message-level authorship role — who generated this message.
 *  Distinct from conversation Member (who participates in the conversation).
 *  - "system": system-generated messages (hop caps, lifecycle events)
 *  - "user": human user sent this message
 *  - "agent": an agent model produced this message
 *  - "tool": a tool execution produced this content
 *  Conversation Member.kind is "agent" | "human" — a different layer (participation, not authorship). */
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
  conversationId?: string;
  visibility?: "internal" | "conversation";
  createdAt?: number;
  updatedAt?: number;
  error?: MessageError;
  /** Transient run status indicator (retrying/compacting). Not persisted. */
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
  /** Usage of the producing model call (assistant messages). Durable
   *  telemetry; see MessageUsage. */
  usage?: MessageUsage;
  /** Provider stop reason for the producing call (end_turn, tool_use, …). */
  stopReason?: string;
  /** Anchored-comment metadata (raft absorption): surfaces render a jump chip. */
  anchor?: { url: string; anchor: unknown };
  /** ADR 0066 D4: floor visit addressee metadata for room display. */
  floorFor?: { agentId: string; agentName: string };
  /** ADR 0070: child conversation opened by a dispatch summary line. */
  dispatchTo?: { conversationId: string };
  /** ADR 0060 D3 / 0070: authoring agent id for ledger-only rows with no run. */
  authorAgentId?: string;
}

/** Provider-reported usage for the model call that produced an assistant
 *  message. Durable telemetry: persisted with the message, never sent on the
 *  wire (converters read text/blocks only). Post-hoc analysis ("how close did
 *  the session get to the window?") reads it from the session file. */
export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
