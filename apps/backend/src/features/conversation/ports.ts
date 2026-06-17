export interface ConversationRow {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
}

export interface MemberRow {
  memberId: string;
  conversationId: string;
  kind: "agent" | "human";
  agentId: string | null;
  userRef: string | null;
  displayName: string | null;
  joinedAt: number;
}

// M17.3: LedgerKind is defined by @my-agent-team/conversation's zod enum.
// We mirror the type here rather than importing it because the enum is exported
// as a const value, and the backend's ESM/NodeNext resolution requires explicit type-only exports.
export type LedgerKind = "message" | "member.joined" | "member.left" | "todo" | "surface.control";

export interface LedgerRow {
  seq: number;
  conversationId: string;
  senderMemberId: string;
  addressedTo: string[];
  kind: LedgerKind;
  content: string; // JSON-encoded
  ts: number;
  /** Run ID that produced this entry. Present for kind="message" entries written by projection. */
  runId?: string;
}

export interface CreateConversationInput {
  conversationId: string;
  triggerMode?: string;
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
  runId?: string;
}

export interface ConversationWithMembers {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
  members: MemberRow[];
}

export interface ConversationPort {
  createConversation(input: CreateConversationInput): ConversationRow;
  getConversation(conversationId: string): ConversationRow | null;
  setConversationTitle(conversationId: string, title: string): void;
  updateHopCount(conversationId: string, count: number): void;
  listConversations(): ConversationWithMembers[];
  listConversationsByAgent(agentId: string): ConversationWithMembers[];
  deleteConversation(conversationId: string): boolean;

  addMember(input: CreateMemberInput): { member: MemberRow; created: boolean };
  getMembers(conversationId: string): MemberRow[];
  getAgentMembers(conversationId: string): MemberRow[];
  removeMember(conversationId: string, memberId: string): boolean;

  appendLedgerEntry(input: AppendLedgerInput): number; // returns seq
  getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerRow[];
  /** Dedup guard: check if (runId, content) already exists in the ledger. */
  hasLedgerContent?(runId: string, content: string): boolean;
}
