import {
  Conversation as ConversationSchema,
  projectForMember,
  resolveTriggerTargets,
} from "@my-agent-team/conversation";
import type { CheckpointReadPort, CheckpointWritePort } from "../checkpoint/ports.js";
import type { ConversationPort, LedgerKind, LedgerRow, MemberRow } from "./ports.js";

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
  forkRun: (
    runId: string,
    threadId: string,
    specJson: string,
    ctx: { conversationId: string; agentMemberId: string; agentId: string },
  ) => Promise<{ runId: string; attemptId: string }>;
}

export function createConversationService(deps: ConversationServiceDeps) {
  const { port, checkpointWrite, activeConversations, maxConsecutiveAgentHops, forkRun } = deps;
  // Track pending run count per conversation — lock released only when
  // all triggered runs complete, not just the first one.
  const pendingRuns = new Map<string, number>();

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
    kind: LedgerKind;
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

  /** Project a ledger entry into all agent member checkpoints.
   *  M14.6: "todo" entries are UI-only — never projected into agent checkpoints
   *  (todo JSON would pollute the model's conversation context). */
  async function broadcastMessage(entry: LedgerRow): Promise<void> {
    if (entry.kind === "todo") return; // UI-only, never projected

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
    port, // Expose port for HTTP layer (thin adapter pattern)
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
      const targets = resolveTriggerTargets(conv, input.addressedTo);
      const triggeredRuns: Array<{ agentMemberId: string; runId: string }> = [];

      // ── Hop count: reset on human/external, increment only for known agent members ──
      const convRow = port.getConversation(input.conversationId);
      const senderIsAgent = members.some(
        (m) => m.memberId === input.senderMemberId && m.kind === "agent",
      );
      if (isHumanMember(members, input.senderMemberId) || isSystemSender(input.senderMemberId)) {
        port.updateHopCount(input.conversationId, 0);
      } else if (senderIsAgent) {
        // L4: only increment for known agent members (not unknown senders)
        port.updateHopCount(input.conversationId, (convRow?.hopCount ?? 0) + 1);
      }
      // Unknown senders: unchanged hop count

      // ── Guards: check BEFORE writing (C3 fix) ──

      let hopCapped = false;
      if (targets.length > 0) {
        // Single-active guard
        if (activeConversations.has(input.conversationId)) {
          throw new ConversationBusyError(input.conversationId);
        }

        // Hop hard-cap check (after hop count update, so human reset takes effect)
        const currentHop = port.getConversation(input.conversationId)?.hopCount ?? 0;
        hopCapped = currentHop > maxConsecutiveAgentHops;
      }

      // ── Append this message to ledger + broadcast (always, even if hop-capped) ──
      const seq = await appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: input.addressedTo,
        kind: "message",
        content: input.content,
      });

      // ── @ trigger: fork agent run for each target (skip if hop-capped) ──
      if (targets.length > 0 && !hopCapped) {
        activeConversations.add(input.conversationId);
        // Track pending count — lock released only when all complete
        pendingRuns.set(input.conversationId, targets.length);
        try {
          for (const target of targets) {
            try {
              const runId = crypto.randomUUID();
              const threadId = deriveThreadId(input.conversationId, target.memberId);
              const { runId: rId } = await forkRun(runId, threadId, "", {
                conversationId: input.conversationId,
                agentMemberId: target.memberId,
                agentId: target.agentId,
              });
              triggeredRuns.push({ agentMemberId: target.memberId, runId: rId });
            } catch (err) {
              console.error(
                `[conversation] forkRun failed for ${target.memberId}:`,
                err instanceof Error ? err.message : String(err),
              );
              // Decrement counter for failed fork
              pendingRuns.set(
                input.conversationId,
                (pendingRuns.get(input.conversationId) ?? 1) - 1,
              );
            }
          }
        } finally {
          // Release lock immediately if no runs were started at all
          const remaining = pendingRuns.get(input.conversationId) ?? 0;
          if (remaining <= 0) {
            activeConversations.delete(input.conversationId);
            pendingRuns.delete(input.conversationId);
          }
        }
      } else if (hopCapped) {
        // Broadcast system message about the cap (no fork)
        await appendAndBroadcast({
          conversationId: input.conversationId,
          senderMemberId: "__system__",
          addressedTo: [],
          kind: "message",
          content: {
            text: `[系统] 连续 agent→agent 触发达上限（${maxConsecutiveAgentHops}），已暂停，等待真人介入。`,
          },
        });
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
        agentId: input.agentId,
        userRef: input.userRef,
        displayName: input.displayName,
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
      port.removeMember(conversationId, memberId);

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
      opts?: { afterSeq?: number; signal?: AbortSignal; pollMs?: number },
    ): AsyncIterable<LedgerRow> {
      const since = opts?.afterSeq ?? 0;
      const pollMs = opts?.pollMs ?? 500;
      let lastSeq = since;
      let emptyPolls = 0;
      const maxEmptyPolls = 120; // ~60s at 500ms

      // First, yield all existing entries (catch up)
      const initial = port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
      for (const entry of initial) {
        yield entry;
        lastSeq = entry.seq;
      }

      // Then long-poll for new entries
      while (true) {
        if (opts?.signal?.aborted) break;

        const entries = port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
        for (const entry of entries) {
          yield entry;
          lastSeq = entry.seq;
          emptyPolls = 0; // reset on data
        }

        if (entries.length === 0) {
          if (pollMs === 0) break; // no polling — exit immediately
          emptyPolls++;
          if (emptyPolls >= maxEmptyPolls) break; // timeout — client reconnects
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }
    },
    /** M14.6: Append a todo snapshot to the conversation ledger (UI-only, not projected to agents). */
    async appendTodo(
      conversationId: string,
      senderMemberId: string,
      todos: unknown,
    ): Promise<void> {
      await appendAndBroadcast({
        conversationId,
        senderMemberId,
        addressedTo: [],
        kind: "todo",
        content: { todos },
      });
    },

    /** Release the conversation lock when ALL triggered runs complete. */
    completeRun(conversationId: string, _threadId: string, _runId: string): void {
      const remaining = (pendingRuns.get(conversationId) ?? 1) - 1;
      if (remaining <= 0) {
        activeConversations.delete(conversationId);
        pendingRuns.delete(conversationId);
      } else {
        pendingRuns.set(conversationId, remaining);
      }
    },

    /** M14.4: Trigger agent runs from agent-to-agent @mentions.
     *  Only forks runs — does NOT append ledger entries (caller already did).
     *  Best-effort: silently skips if conversation busy or hop-capped. */
    async triggerMentionedAgents(input: {
      conversationId: string;
      senderMemberId: string;
      addressedTo: string[];
    }): Array<{ agentMemberId: string; runId: string }> {
      const triggeredRuns: Array<{ agentMemberId: string; runId: string }> = [];
      if (input.addressedTo.length === 0) return triggeredRuns;

      const members = port.getMembers(input.conversationId);
      const convRow = port.getConversation(input.conversationId);
      if (!convRow) return triggeredRuns;

      // Build conv for resolveTriggerTargets
      const conv = buildConversation(input.conversationId);
      if (!conv) return triggeredRuns;

      const targets = resolveTriggerTargets(conv, input.addressedTo);
      if (targets.length === 0) return triggeredRuns;

      // Increment hop count for agent sender
      const senderIsAgent = members.some(
        (m) => m.memberId === input.senderMemberId && m.kind === "agent",
      );
      if (senderIsAgent) {
        port.updateHopCount(input.conversationId, (convRow.hopCount ?? 0) + 1);
      }

      // Hop hard-cap check
      const currentHop = port.getConversation(input.conversationId)?.hopCount ?? 0;
      if (currentHop > maxConsecutiveAgentHops) return triggeredRuns;

      // Conversation busy guard (best-effort: skip, don't throw)
      if (activeConversations.has(input.conversationId)) return triggeredRuns;

      // Fork runs
      activeConversations.add(input.conversationId);
      pendingRuns.set(input.conversationId, targets.length);
      try {
        for (const target of targets) {
          try {
            const runId = crypto.randomUUID();
            const threadId = deriveThreadId(input.conversationId, target.memberId);
            const { runId: rId } = await forkRun(runId, threadId, "", {
              conversationId: input.conversationId,
              agentMemberId: target.memberId,
              agentId: target.agentId,
            });
            triggeredRuns.push({ agentMemberId: target.memberId, runId: rId });
          } catch (err) {
            console.error(
              `[conversation] triggerMentionedAgents forkRun failed for ${target.memberId}:`,
              err instanceof Error ? err.message : String(err),
            );
            pendingRuns.set(input.conversationId, (pendingRuns.get(input.conversationId) ?? 1) - 1);
          }
        }
      } finally {
        const remaining = pendingRuns.get(input.conversationId) ?? 0;
        if (remaining <= 0) {
          activeConversations.delete(input.conversationId);
          pendingRuns.delete(input.conversationId);
        }
      }

      return triggeredRuns;
    },
  };
}
export type ConversationService = ReturnType<typeof createConversationService>;
