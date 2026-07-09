import type { LedgerEntry, LedgerKind, Member } from "@my-agent-team/conversation";

// Re-export canonical types from @my-agent-team/conversation
export type { LedgerKind };

export interface ConversationRow {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
  /** M19: Origin — 'user' for user chats, 'issue' for issue-side conversations. */
  origin: string;
}

export interface MemberRow {
  memberId: string;
  conversationId: string;
  /** M17.5: Derived from canonical Member.kind (agent|human). */
  kind: Member["kind"];
  agentId: string | null;
  userRef: string | null;
  displayName: string | null;
  /** Session binding for agent members. Null for human members or before first run. */
  sessionId: string | null;
  joinedAt: number;
}

// M17.5: LedgerEntry is imported from the canonical @my-agent-team/conversation
// package (single ontology). spanId was added to the canonical LedgerEntry schema.
export type { LedgerEntry };

export interface CreateConversationInput {
  conversationId: string;
  triggerMode?: string;
  origin?: string;
  createdAt: number;
}

export interface CreateMemberInput {
  memberId: string;
  conversationId: string;
  kind: "agent" | "human";
  agentId?: string | null;
  userRef?: string | null;
  displayName?: string | null;
  joinedAt: number;
}

export interface AppendLedgerInput {
  conversationId: string;
  senderMemberId: string;
  addressedTo?: string[];
  kind: LedgerKind;
  content: string; // JSON-encoded
  ts: number;
  /** Optional: run ID for dedup (incremental projection). */
  spanId?: string;
}

export interface ConversationWithMembers {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
  members: MemberRow[];
  /** Last ledger entry timestamp; null when the conversation has no messages yet. */
  lastActivityAt: number | null;
}

export interface ConversationPort {
  createConversation(input: CreateConversationInput): ConversationRow;
  getConversation(conversationId: string): ConversationRow | null;
  setConversationTitle(conversationId: string, title: string): void;
  updateHopCount(conversationId: string, count: number): void;
  listConversations(): ConversationWithMembers[];
  listConversationsByAgent(agentId: string): ConversationWithMembers[];
  deleteConversation(conversationId: string): boolean;
  /** Last ledger entry timestamp for a conversation, or null when empty. */
  getLastActivityAt?(conversationId: string): number | null;

  addMember(input: CreateMemberInput): { member: MemberRow; created: boolean };
  getMembers(conversationId: string): MemberRow[];
  getAgentMembers(conversationId: string): MemberRow[];
  removeMember(conversationId: string, memberId: string): boolean;
  /** Get the sessionId bound to a member (for conversation session reuse). */
  getMemberSessionId(conversationId: string, memberId: string): string | null;
  /** Set the sessionId bound to a member (after sessionManager.create). */
  updateMemberSessionId(conversationId: string, memberId: string, sessionId: string): void;

  appendLedgerEntry(input: AppendLedgerInput): number; // returns seq
  getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[];
  /** Update content of an existing ledger row by seq (in-place streaming refresh). */
  updateLedgerContent?(seq: number, content: string, ts: number): void;
  /** Dedup guard: check if (spanId, content) already exists in the ledger. */
  hasLedgerContent?(spanId: string, content: string): boolean;
  /** Keyword search across all conversation ledger content. */
  searchLedger(
    keyword: string,
    limit?: number,
  ): Array<{
    conversationId: string;
    seq: number;
    snippet: string;
    ts: number;
  }>;
}
