import {
  Conversation as ConversationSchema,
  resolveTriggerTargets,
} from "@my-agent-team/conversation";
import type { MessageRevision } from "@my-agent-team/message";
import {
  ContentBlockSchema,
  humanMessageId,
  MessageRevisionSchema,
  serializeMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";
import type { ConversationLock } from "./lock.js";
import type { ConversationPort, LedgerEntry, LedgerKind, MemberRow } from "./ports.js";

export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`Conversation busy: ${conversationId}`);
    this.name = "ConversationBusyError";
  }
}

function deriveSessionId(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

/** Reserved memberId for the conversation owner (the human who owns an
 *  issue-/cron-spawned conversation). It is a member id, NOT an agent id —
 *  sessionIds derived from it (`${conversationId}:${OWNER_MEMBER_ID}`) follow
 *  the standard `${conversationId}:${memberId}` shape, not the agent shape. */
export const OWNER_MEMBER_ID = "owner";

/** Parse a sessionId back into its constituent parts.
 *  Inverse of deriveSessionId. First colon separates conversationId from memberId;
 *  memberId may itself contain colons. */
export function parseSessionId(sessionId: string): { conversationId: string; memberId: string } {
  const idx = sessionId.indexOf(":");
  if (idx < 0) return { conversationId: sessionId, memberId: "" };
  return { conversationId: sessionId.slice(0, idx), memberId: sessionId.slice(idx + 1) };
}

function isHumanMember(members: MemberRow[], memberId: string): boolean {
  return members.some((m) => m.memberId === memberId && m.kind === "human");
}

function isSystemSender(memberId: string): boolean {
  return memberId === "__system__";
}

export interface ConversationServiceDeps {
  port: ConversationPort;
  /** M17.5 P4: ConversationLock replaces ad-hoc activeConversations Set + pendingRuns Map. */
  lock: ConversationLock;
  maxConsecutiveAgentHops: number;
  startAgentRun: (
    spanId: string,
    sessionId: string,
    ctx: {
      conversationId: string;
      agentMemberId: string;
      agentId: string;
      ledgerSeq: number;
      /** The user's input text — passed through to AgentSession.prompt() so the agent receives the actual message. */
      input?: string;
    },
  ) => Promise<{ spanId: string; attemptSeq: number }>;
  idGen: () => string;
  /** Verify a spanId belongs to the given conversation. Throws if not. */
  verifyRunOwnsConversation?: (spanId: string, conversationId: string) => Promise<void>;
}

export function createConversationService(deps: ConversationServiceDeps) {
  const { port, lock, maxConsecutiveAgentHops, startAgentRun } = deps;

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

  /** Append a ledger entry and broadcast it to all agent checkpoints. Returns seq.
   *  For kind:"message", content MUST be a MessageRevision — validated via
   *  serializeMessageRevision. Other kinds use plain JSON.stringify. */
  async function appendAndBroadcast(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    kind: LedgerKind;
    content: unknown;
    /** When false, skip thread_projection write (startAgentRun reads from ledger directly). */
    broadcast?: boolean;
  }): Promise<number> {
    const ts = Date.now();
    const serialized =
      input.kind === "message"
        ? serializeMessageRevision(MessageRevisionSchema.parse(input.content) as MessageRevision)
        : JSON.stringify(input.content);
    const seq = port.appendLedgerEntry({
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: input.kind,
      content: serialized,
      ts,
    });
    if (input.broadcast !== false) {
      await broadcastMessage({
        seq,
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: input.addressedTo,
        kind: input.kind,
        content: serialized,
        ts,
      });
    }
    return seq;
  }

  /** Project a ledger entry into all agent member checkpoints.
   *  M14.6: "todo" entries are UI-only — never projected into agent checkpoints
   *  (todo JSON would pollute the model's conversation context). */
  async function broadcastMessage(
    entry: LedgerEntry,
    _opts?: { excludeMemberId?: string },
  ): Promise<void> {
    if (entry.kind === "todo" || entry.kind === "surface.control") return;

    // broadcastMessage no longer writes to thread-projection.
    // Agent members read directly from the ledger via conversation tools.
  }

  /** Shared fork-run loop: lock conversation, fork runs for targets, release when all complete.
   *  Returns triggered run IDs. Errors for individual targets are logged and skipped. */
  async function forkAgentRuns(
    conversationId: string,
    targets: Array<{ memberId: string; agentId: string }>,
    ledgerSeq: number,
    input?: string,
  ): Promise<Array<{ agentMemberId: string; spanId: string }>> {
    const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];
    lock.acquire(conversationId, targets.length);
    for (const target of targets) {
      try {
        const spanId = crypto.randomUUID();
        const sessionId = deriveSessionId(conversationId, target.memberId);
        const { spanId: rId } = await startAgentRun(spanId, sessionId, {
          conversationId,
          agentMemberId: target.memberId,
          agentId: target.agentId,
          ledgerSeq,
          input,
        });
        triggeredRuns.push({ agentMemberId: target.memberId, spanId: rId });
      } catch (err) {
        console.error(
          `[conversation] startAgentRun failed for ${target.memberId}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Decrement pending count for failed fork
        lock.releaseOne(conversationId);
      }
    }
    return triggeredRuns;
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
    }): Promise<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; spanId: string }> }> {
      const conv = buildConversation(input.conversationId);
      if (!conv) throw new Error(`Conversation not found: ${input.conversationId}`);

      const members = port.getMembers(input.conversationId);
      const targets = resolveTriggerTargets(conv, input.addressedTo);
      const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];

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
        if (lock.isActive(input.conversationId)) {
          throw new ConversationBusyError(input.conversationId);
        }

        // Hop hard-cap check (after hop count update, so human reset takes effect)
        const currentHop = port.getConversation(input.conversationId)?.hopCount ?? 0;
        hopCapped = currentHop > maxConsecutiveAgentHops;
      }

      // ── Append this message to ledger as a MessageRevision (no broadcast — startAgentRun reads from ledger) ──
      const userRev: MessageRevision = {
        // M17.2 fix: use UUID to prevent same-ms collision when
        // the ledger is folded by messageId. Two posts in the same millisecond
        // would share an id and the second would silently overwrite the first.
        messageId: humanMessageId(input.conversationId, input.senderMemberId),

        role: "user",
        state: "done",
        text: typeof input.content === "string" ? input.content : undefined,
        blocks: Array.isArray(input.content)
          ? (ContentBlockSchema.array().parse(input.content) as MessageRevision["blocks"])
          : undefined,
        conversationId: input.conversationId,
        visibility: "conversation",
        updatedAt: Date.now(),
      };
      const seq = await appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: input.addressedTo,
        kind: "message",
        content: userRev,
        broadcast: false,
      });

      // ── @ trigger: fork agent run for each target (skip if hop-capped) ──
      if (targets.length > 0 && !hopCapped) {
        const userText = typeof input.content === "string" ? input.content : "";
        const runs = await forkAgentRuns(input.conversationId, targets, seq, userText);
        triggeredRuns.push(...runs);
      } else if (hopCapped) {
        // Broadcast system message about the cap (no fork)
        const sysRev: MessageRevision = {
          messageId: systemMessageId(input.conversationId, "hopcap"),
          role: "system",
          state: "done",
          text: `[系统] 连续 agent→agent 触发达上限（${maxConsecutiveAgentHops}），已暂停，等待真人介入。`,
          visibility: "conversation",
          updatedAt: Date.now(),
        };
        await appendAndBroadcast({
          conversationId: input.conversationId,
          senderMemberId: "__system__",
          addressedTo: [],
          kind: "message",
          content: sysRev,
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
      const { created } = port.addMember({
        memberId: input.memberId,
        conversationId: input.conversationId,
        kind: input.kind,
        agentId: input.agentId,
        userRef: input.userRef,
        displayName: input.displayName,
        joinedAt: Date.now(),
      });

      if (!created) return; // Already a member — don't re-broadcast member.joined

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
    ): AsyncIterable<LedgerEntry> {
      const since = opts?.afterSeq ?? 0;
      const pollMs = opts?.pollMs ?? 500;
      let lastSeq = since;
      let silentPolls = 0;
      const heartbeatInterval = 30; // ~15s at 500ms poll

      // First, yield all existing entries (catch up)
      const initial = port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
      for (const entry of initial) {
        yield entry;
        lastSeq = entry.seq;
      }

      // Then long-poll for new entries — no idle timeout.
      // pollMs=0 means one-shot (tests); otherwise stay alive indefinitely.
      while (true) {
        if (opts?.signal?.aborted) break;

        const entries = port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
        for (const entry of entries) {
          yield entry;
          lastSeq = entry.seq;
          silentPolls = 0;
        }

        if (entries.length === 0) {
          if (pollMs === 0) break; // one-shot — exit immediately
          silentPolls++;
          // Heartbeat: yield a sentinel row every ~15s so sseResponse
          // can emit an SSE comment to keep the connection alive.
          // Frontend EventSource ignores SSE comments (not a business event).
          if (silentPolls % heartbeatInterval === 0) {
            yield {
              seq: 0,
              conversationId,
              senderMemberId: "",
              addressedTo: [],
              kind: "message" as const,
              content: "",
              ts: Date.now(),
              _heartbeat: true as const,
            } as LedgerEntry & { _heartbeat: true }; // sentinel — not persisted, only yielded to SSE handler
          }
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
    completeRun(conversationId: string, _sessionId: string, _runId: string): void {
      lock.releaseOne(conversationId);
    },

    /** M17.5 P7: Write an assistant message revision directly to the ledger.
     *  This is the SOLE authoritative entry for assistant messages in the conversation. */
    async appendAssistantMessage(input: {
      conversationId: string;
      senderMemberId: string;
      spanId: string;
      revision: MessageRevision;
    }): Promise<number> {
      const stamped: MessageRevision = {
        ...input.revision,
        conversationId: input.conversationId,
        spanId: input.spanId,
      };
      const serialized = serializeMessageRevision(stamped);
      const ts = Date.now();
      const seq = port.appendLedgerEntry({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: [],
        kind: "message",
        content: serialized,
        ts,
        spanId: input.spanId,
      });
      return seq;
    },

    /** M14.4: Trigger agent runs from agent-to-agent @mentions.
     *  Only forks runs — does NOT append ledger entries (caller already did).
     *  Best-effort: silently skips if conversation busy or hop-capped. */
    async triggerMentionedAgents(input: {
      conversationId: string;
      senderMemberId: string;
      addressedTo: string[];
    }): Promise<Array<{ agentMemberId: string; spanId: string }>> {
      const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];
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
      if (lock.isActive(input.conversationId)) return triggeredRuns;

      // Fork runs (shared helper with postMessage)
      return forkAgentRuns(input.conversationId, targets, 0);
    },

    /** M15.1: Start a fresh conversation from a surface control tool call.
     *  Copies agent + human members, writes surface.control to old ledger. */
    async startNewConversationForSurface(input: {
      oldConversationId: string;
      reason: string;
      title?: string;
      requestedByRunId: string;
      idempotencyKey: string;
    }): Promise<{ oldConversationId: string; newConversationId: string; controlSeq: number }> {
      const { oldConversationId, reason, title, requestedByRunId, idempotencyKey } = input;

      // 1. Idempotency: check if this control was already written
      const existingEntries = port.getLedgerEntries(oldConversationId);
      for (const entry of existingEntries) {
        if (entry.kind !== "surface.control") continue;
        try {
          const raw = typeof entry.content === "string" ? JSON.parse(entry.content) : entry.content;
          const c = raw as {
            type: string;
            requestedByRunId: string;
            newConversationId: string;
            idempotencyKey?: string;
          };
          if (c.type === "lark.start_new_conversation" && c.idempotencyKey === idempotencyKey) {
            return {
              oldConversationId,
              newConversationId: c.newConversationId,
              controlSeq: entry.seq,
            };
          }
        } catch {
          /* malformed entry — skip */
        }
      }

      // 2. Verify run owns the old conversation
      if (deps.verifyRunOwnsConversation) {
        await deps.verifyRunOwnsConversation(requestedByRunId, oldConversationId);
      }

      // 3. Create new conversation
      const newConversationId = deps.idGen();
      port.createConversation({
        conversationId: newConversationId,
        triggerMode: "mention",
        createdAt: Date.now(),
      });
      if (title) {
        port.setConversationTitle(newConversationId, title);
      }

      // 4. Copy agent members + Lark human members (NOT history)
      const members = port.getMembers(oldConversationId);
      for (const m of members) {
        if (m.kind === "agent" || (m.kind === "human" && m.userRef?.startsWith("lark:"))) {
          port.addMember({
            memberId: m.memberId,
            conversationId: newConversationId,
            kind: m.kind,
            agentId: m.agentId,
            userRef: m.userRef,
            displayName: m.displayName,
            joinedAt: Date.now(),
          });
        }
      }

      // 5. Write surface.control entry to OLD conversation ledger
      const control = {
        type: "lark.start_new_conversation",
        oldConversationId,
        newConversationId,
        reason,
        requestedByRunId,
        idempotencyKey,
      };
      const controlSeq = await appendAndBroadcast({
        conversationId: oldConversationId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "surface.control",
        content: control,
      });

      return { oldConversationId, newConversationId, controlSeq };
    },
  };
}
export type ConversationService = ReturnType<typeof createConversationService>;
