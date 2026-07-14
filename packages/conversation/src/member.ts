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
  userRef: z.string().min(1).optional(),
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

// ─── resolveTriggerTargets ──────────────────────────────────

export function resolveTriggerTargets(conv: Conversation, addressedTo: string[]): AgentMember[] {
  const memberMap = new Map(conv.members.map((m) => [m.memberId, m]));
  return addressedTo
    .map((id) => memberMap.get(id))
    .filter((m): m is AgentMember => m?.kind === "agent");
}
