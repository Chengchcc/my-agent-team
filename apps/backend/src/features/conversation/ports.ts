export interface ConversationRow {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
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

export interface LedgerRow {
  seq: number;
  conversationId: string;
  senderMemberId: string;
  addressedTo: string[];
  kind: "message" | "member.joined" | "member.left";
  content: string; // JSON-encoded
  ts: number;
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
  kind: "message" | "member.joined" | "member.left";
  content: string; // JSON-encoded
  ts: number;
}

export interface ConversationPort {
  createConversation(input: CreateConversationInput): ConversationRow;
  getConversation(conversationId: string): ConversationRow | null;
  updateHopCount(conversationId: string, count: number): void;

  addMember(input: CreateMemberInput): MemberRow;
  getMembers(conversationId: string): MemberRow[];
  getAgentMembers(conversationId: string): MemberRow[];
  removeMember(memberId: string): boolean;

  appendLedgerEntry(input: AppendLedgerInput): number; // returns seq
  getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerRow[];
}
