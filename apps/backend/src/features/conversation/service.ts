import { Conversation as ConversationSchema, projectForMember, resolveTriggerTargets } from "@my-agent-team/conversation";
import type { CheckpointReadPort, CheckpointWritePort } from "../checkpoint/ports.js";
import type { ConversationPort, LedgerRow, MemberRow } from "./ports.js";

export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`Conversation busy: ${conversationId}`);
    this.name = "ConversationBusyError";
  }
}

function deriveThreadId(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

function isHumanMember(members: MemberRow[], memberId: string): boolean {
  return members.some((m) => m.memberId === memberId && m.kind === "human");
}

function isSystemSender(memberId: string): boolean {
  return memberId === "__system__";
}

export interface ConversationServiceDeps {
  port: ConversationPort;
  checkpointRead: CheckpointReadPort;
  checkpointWrite: CheckpointWritePort;
  activeConversations: Set<string>;
  maxConsecutiveAgentHops: number;
  forkRun: (runId: string, threadId: string, specJson: string) => { runId: string; attemptId: string };
}

export function createConversationService(deps: ConversationServiceDeps) {
  const { port, checkpointRead, checkpointWrite, activeConversations, maxConsecutiveAgentHops, forkRun } = deps;

  /** Load members and build Conversation for pure helpers. */
  function buildConversation(conversationId: string) {
    const convRow = port.getConversation(conversationId);
    if (!convRow) return null;
    const allMembers = port.getMembers(conversationId).map((m) => ({
      kind: m.kind as "agent" | "human",
      memberId: m.memberId,
      agentId: m.agentId ?? undefined,
      userRef: m.userRef ?? undefined,
      displayName: m.displayName ?? undefined,
    }));
    return ConversationSchema.parse({
      conversationId,
      members: allMembers,
      triggerMode: convRow.triggerMode,
      createdAt: convRow.createdAt,
    });
  }

  /** Append a ledger entry and broadcast it to all agent checkpoints. Returns seq. */
  async function appendAndBroadcast(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    kind: "message" | "member.joined" | "member.left";
    content: unknown;
  }): Promise<number> {
    const ts = Date.now();
    const seq = port.appendLedgerEntry({
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: input.kind,
      content: JSON.stringify(input.content),
      ts,
    });

    const entry: LedgerRow = {
      seq,
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: input.kind,
      content: JSON.stringify(input.content),
      ts,
    };

    await broadcastMessage(entry);
    return seq;
  }

  /** Project a ledger entry into all agent member checkpoints. */
  async function broadcastMessage(entry: LedgerRow): Promise<void> {
    const conv = buildConversation(entry.conversationId);
    if (!conv) return;

    const agentMembers = port.getAgentMembers(entry.conversationId);
    let content: unknown;
    try {
      content = JSON.parse(entry.content);
    } catch {
      content = entry.content;
    }

    for (const member of agentMembers) {
      const threadId = deriveThreadId(entry.conversationId, member.memberId);
      const projected = projectForMember(
        {
          seq: entry.seq,
          conversationId: entry.conversationId,
          senderMemberId: entry.senderMemberId,
          addressedTo: entry.addressedTo,
          kind: entry.kind,
          content,
          ts: entry.ts,
        },
        member.memberId,
        conv,
      );

      await checkpointWrite.appendMessages(threadId, [
        { role: projected.role, content: projected.text },
      ]);
    }
  }

  return {
    broadcastMessage,

    // ─── postMessage ────────────────────────────────

    async postMessage(input: {
      conversationId: string;
      senderMemberId: string;
      addressedTo: string[];
      content: unknown;
    }): Promise<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; runId: string }> }> {
      const conv = buildConversation(input.conversationId);
      if (!conv) throw new Error(`Conversation not found: ${input.conversationId}`);

      const members = port.getMembers(input.conversationId);

      // Hop count: reset on human/external, increment on agent
      const convRow = port.getConversation(input.conversationId);
      if (isHumanMember(members, input.senderMemberId) || isSystemSender(input.senderMemberId)) {
        port.updateHopCount(input.conversationId, 0);
      } else {
        port.updateHopCount(input.conversationId, (convRow?.hopCount ?? 0) + 1);
      }

      // Append ledger + broadcast
      const seq = await appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: input.addressedTo,
        kind: "message",
        content: input.content,
      });

      // @ trigger: resolve targets, check constraints, fork
      const triggeredRuns: Array<{ agentMemberId: string; runId: string }> = [];
      const targets = resolveTriggerTargets(conv, input.addressedTo);

      if (targets.length > 0) {
        // Single-active guard
        if (activeConversations.has(input.conversationId)) {
          throw new ConversationBusyError(input.conversationId);
        }

        // Hop hard-cap
        const currentHop = port.getConversation(input.conversationId)?.hopCount ?? 0;
        if (currentHop > maxConsecutiveAgentHops) {
          // Append system message and broadcast — no fork
          await appendAndBroadcast({
            conversationId: input.conversationId,
            senderMemberId: "__system__",
            addressedTo: [],
            kind: "message",
            content: {
              text: `[系统] 连续 agent→agent 触发达上限（${maxConsecutiveAgentHops}），已暂停，等待真人介入。`,
            },
          });
        } else {
          // Fork first target only (M10 single-active: max 1)
          // Future M12: may fork all targets concurrently
          const target = targets[0]!;
          const runId = crypto.randomUUID();
          const threadId = deriveThreadId(input.conversationId, target.memberId);

          activeConversations.add(input.conversationId);
          const { runId: rId } = forkRun(runId, threadId, "");
          triggeredRuns.push({ agentMemberId: target.memberId, runId: rId });
        }
      }

      return { seq, triggeredRuns };
    },

    // ─── Member join/leave ──────────────────────────

    async addMember(input: {
      conversationId: string;
      memberId: string;
      kind: "agent" | "human";
      agentId?: string;
      userRef?: string;
      displayName?: string;
    }): Promise<void> {
      port.addMember({
        memberId: input.memberId,
        conversationId: input.conversationId,
        kind: input.kind,
        agentId: input.agentId ?? null,
        userRef: input.userRef ?? null,
        displayName: input.displayName ?? null,
        joinedAt: Date.now(),
      });

      // Broadcast system message
      const members = port.getMembers(input.conversationId);
      await appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "member.joined",
        content: {
          memberId: input.memberId,
          members: members.map((m) => ({
            memberId: m.memberId,
            kind: m.kind,
            displayName: m.displayName,
          })),
        },
      });
    },

    async removeMember(conversationId: string, memberId: string): Promise<void> {
      const members = port.getMembers(conversationId);
      port.removeMember(memberId);

      await appendAndBroadcast({
        conversationId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "member.left",
        content: {
          memberId,
          members: members
            .filter((m) => m.memberId !== memberId)
            .map((m) => ({
              memberId: m.memberId,
              kind: m.kind,
              displayName: m.displayName,
            })),
        },
      });
    },

    // ─── SSE projection ─────────────────────────────

    async *subscribeConversation(
      conversationId: string,
      opts?: { afterSeq?: number; signal?: AbortSignal },
    ): AsyncIterable<LedgerRow> {
      const since = opts?.afterSeq ?? 0;
      let lastSeq = since;

      while (true) {
        if (opts?.signal?.aborted) break;

        const entries = port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
        for (const entry of entries) {
          yield entry;
          lastSeq = entry.seq;
        }

        // If nothing new, done (non-blocking — caller polls or uses EventSource reconnect)
        break;
      }
    },
  };
}
