import { parseMessageRevision } from "@my-agent-team/message";
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

// ─── LedgerKind (M17.3: single source of truth for entry kind) ──

export const LedgerKind = z.enum([
  "message",
  "member.joined",
  "member.left",
  "todo",
  "surface.control",
]);

// ─── LedgerEntry ────────────────────────────────────────────

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: LedgerKind,
  // M17.2: content is always a serialized string (JSON.stringify for structured payloads).
  // Message entries use serializeMessageRevision; other kinds use JSON.stringify.
  content: z.string(),
  ts: z.number(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Parse a ledger entry from wire/SSE, throwing on invalid shape. */
export function parseLedgerEntry(raw: unknown): LedgerEntry {
  return LedgerEntry.parse(raw);
}

/** Safe-parse a ledger entry (returns success/error instead of throwing). */
export function safeParseLedgerEntry(raw: unknown): z.SafeParseReturnType<unknown, LedgerEntry> {
  return LedgerEntry.safeParse(raw);
}

/** Serialize a ledger entry to JSON. */
export function serializeLedgerEntry(e: LedgerEntry): string {
  return JSON.stringify(LedgerEntry.parse(e));
}

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

/** M17.2: Extract displayable text from ledger content using unified parser.
 *  LedgerEntry.content is always a serialized string. For message entries it's
 *  a serialized MessageRevision; for other kinds it's JSON.stringify'd payload. */
function formatContent(content: unknown): string {
  if (typeof content === "string") {
    // Try parsing as MessageRevision first (common path for message entries)
    try {
      const parsed = JSON.parse(content) as unknown;
      const rev = parseMessageRevision(parsed);
      // M17.2 fix: framework emits blocks not text — extract text from text blocks
      return (
        rev.text ??
        rev.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join(" ") ??
        ""
      );
    } catch {
      // Fallback: try legacy {text} shape
      try {
        const obj = JSON.parse(content) as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text;
      } catch {
        // Not JSON — return as-is
      }
      return content;
    }
  }
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
      // M17.2: content is always a serialized string — parse before reading
      let payload:
        | { memberId?: string; members?: Array<{ displayName?: string; memberId: string }> }
        | undefined;
      try {
        payload =
          typeof entry.content === "string"
            ? (JSON.parse(entry.content) as typeof payload)
            : (entry.content as typeof payload);
      } catch {
        payload = undefined;
      }
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
  assistantMessageId,
  isOpenMessageState,
  isTerminalMessageState,
  type Message,
  type MessageRevision,
  type MessageRole,
  type MessageState,
  mergeMessageRevision,
  parseMessageRevision,
} from "@my-agent-team/message";

// ─── resolveTriggerTargets ──────────────────────────────────

export function resolveTriggerTargets(conv: Conversation, addressedTo: string[]): AgentMember[] {
  const memberMap = new Map(conv.members.map((m) => [m.memberId, m]));
  return addressedTo
    .map((id) => memberMap.get(id))
    .filter((m): m is AgentMember => m?.kind === "agent");
}
