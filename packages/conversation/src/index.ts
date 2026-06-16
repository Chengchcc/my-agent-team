import { z } from "zod";

// ─── Member ─────────────────────────────────────────────────

export const AgentMember = z.object({
  kind: z.literal("agent"),
  memberId: z.string().min(1),
  agentId: z.string().min(1),
  displayName: z.string().optional(),
});

export const HumanMember = z.object({
  kind: z.literal("human"),
  memberId: z.string().min(1),
  userRef: z.string().min(1),
  displayName: z.string().optional(),
});

export const Member = z.discriminatedUnion("kind", [AgentMember, HumanMember]);

export type AgentMember = z.infer<typeof AgentMember>;
export type HumanMember = z.infer<typeof HumanMember>;
export type Member = z.infer<typeof Member>;

// ─── Conversation ───────────────────────────────────────────

export const TriggerMode = z.enum(["mention", "all"]).default("mention");

export const Conversation = z.object({
  conversationId: z.string().min(1),
  members: z.array(Member).min(1),
  triggerMode: TriggerMode,
  createdAt: z.number(),
});

export type Conversation = z.infer<typeof Conversation>;

// ─── LedgerEntry ────────────────────────────────────────────

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: z.enum(["message", "member.joined", "member.left"]),
  content: z.unknown(),
  ts: z.number(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ─── assertMember ───────────────────────────────────────────

export class MemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`Member not found: ${memberId}`);
    this.name = "MemberNotFoundError";
  }
}

export class NotAgentMemberError extends Error {
  constructor(memberId: string) {
    super(`Member is not an agent: ${memberId}`);
    this.name = "NotAgentMemberError";
  }
}

export function assertMember(conv: Conversation, memberId: string): Member {
  const m = conv.members.find((m) => m.memberId === memberId);
  if (!m) throw new MemberNotFoundError(memberId);
  return m;
}

export function assertAgentMember(conv: Conversation, memberId: string): AgentMember {
  const m = assertMember(conv, memberId);
  if (m.kind !== "agent") throw new NotAgentMemberError(memberId);
  return m;
}

// ─── projectForMember ───────────────────────────────────────

function displayNameOf(conv: Conversation, memberId: string): string {
  const m = conv.members.find((m) => m.memberId === memberId);
  return m?.displayName ?? memberId;
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return JSON.stringify(content);
}

export function projectForMember(
  entry: LedgerEntry,
  viewerMemberId: string,
  conv: Conversation,
): { role: "user" | "assistant"; text: string } {
  // Own messages → assistant role, no prefix
  if (entry.senderMemberId === viewerMemberId) {
    return { role: "assistant", text: formatContent(entry.content) };
  }

  // System messages → user role with [系统] prefix
  if (entry.senderMemberId === "__system__") {
    const text = formatContent(entry.content);
    // For member events, produce a human-readable description
    if (entry.kind === "member.joined" || entry.kind === "member.left") {
      const verb = entry.kind === "member.joined" ? "加入" : "离开";
      const payload = entry.content as
        | { memberId?: string; members?: Array<{ displayName?: string; memberId: string }> }
        | undefined;
      const who = payload?.memberId ? displayNameOf(conv, payload.memberId) : "未知成员";
      const present =
        payload?.members?.map((m) => displayNameOf(conv, m.memberId)).join(", ") ?? "";
      return {
        role: "user",
        text: `[系统] 成员变化：${who} ${verb}。当前在场：${present}`,
      };
    }
    return { role: "user", text: `[系统] ${text}` };
  }

  // Others' messages → user role with [name]: prefix
  const name = displayNameOf(conv, entry.senderMemberId);
  return { role: "user", text: `[${name}]: ${formatContent(entry.content)}` };
}

// M17.1: Re-export unified Message types from the canonical package.
export {
  type Message,
  type MessageRevision,
  type MessageState,
  type MessageRole,
  parseMessageRevision,
  assistantMessageId,
  isOpenMessageState,
  isTerminalMessageState,
  mergeMessageRevision,
} from "@my-agent-team/message";

// ─── resolveTriggerTargets ──────────────────────────────────

export function resolveTriggerTargets(conv: Conversation, addressedTo: string[]): AgentMember[] {
  const memberMap = new Map(conv.members.map((m) => [m.memberId, m]));
  return addressedTo
    .map((id) => memberMap.get(id))
    .filter((m): m is AgentMember => m?.kind === "agent");
}
