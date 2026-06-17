import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  assistantMessageId,
  isTerminalMessageState,
  parseMessageRevision,
  serializeMessageRevision,
} from "@my-agent-team/message";
import type { ConversationPort } from "./ports.js";
import type { ConversationService } from "./service.js";
import { parseThreadId } from "./service.js";

// ─── @mention helpers ─────────────────────────────────────────

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ─── Preloaded messages (forkRun hot path) ────────────────────

/** Build preloaded Message[] for a run from the conversation ledger.
 *  Eliminates the thread_projection round-trip: the ledger is the canonical
 *  source, and materializing to thread_projection eagerly was a vestige of
 *  M9's checkpointer-only recovery path. */
export function buildPreloadedMessages(
  port: ConversationPort,
  conversationId: string,
  memberId: string,
): Message[] {
  const entries = port.getLedgerEntries(conversationId);
  // M17.2 fix: fold by messageId (后写覆盖先写) so streaming/done revisions of the
  // same assistant message collapse into one entry per messageId. Without folding,
  // each revision row becomes a separate thread message, feeding duplicates to the model.
  const folded = new Map<
    string,
    { role: "user" | "assistant"; rev: ReturnType<typeof parseMessageRevision> }
  >();
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    try {
      const rev = parseMessageRevision(JSON.parse(entry.content));
      const role = entry.senderMemberId === memberId ? "assistant" : "user";
      folded.set(rev.messageId, { role, rev });
    } catch {
      // Malformed or legacy entry — silently skip (old-shape rows are cleaned up by migration)
    }
  }

  // Output in ledger insertion order (Map guarantees insertion order)
  const msgs: Message[] = [];
  for (const { role, rev } of folded.values()) {
    if (rev.text) {
      msgs.push({ role, text: rev.text });
    } else if (rev.blocks && rev.blocks.length > 0) {
      msgs.push({ role, blocks: rev.blocks });
    }
  }
  return msgs;
}

// ─── Per-run accumulator ──────────────────────────────────────

export interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  /** M17: Latest assistant revision written to the ledger for this run.
   *  Updated on each streaming projection; read by onRunComplete for the final done/error revision.
   *  M17.4: This is an optimization — if the process restarts and the accumulator is gone,
   *  onRunComplete falls back to scanning the ledger. */
  latestAssistantRevision: MessageRevision | null;
  /** M17: Serial chain of projection writes — guarantees that same-run rewrites
   *  of the same logical message are ordered. onRunComplete awaits this before
   *  appending the done/error terminal revision. */
  projectionChain: Promise<void>;
}

const runAccumulators = new Map<string, RunAccumulator>();

export function getOrCreateAccumulator(runId: string, senderMemberId: string): RunAccumulator {
  let acc = runAccumulators.get(runId);
  if (!acc) {
    acc = {
      senderMemberId,
      mentionedMemberIds: new Set(),
      lastTodoUpdate: null,
      latestAssistantRevision: null,
      projectionChain: Promise.resolve(),
    };
    runAccumulators.set(runId, acc);
  }
  return acc;
}

export function clearAccumulator(runId: string): void {
  runAccumulators.delete(runId);
}

// ─── Incremental projection (onRunEvent hot path) ─────────────

/** Conversation Projection (incremental) — receive a MessageRevision already
 *  assembled by framework, add conversationId (归属戳), serialize, and write to ledger.
 *  Same messageId across revisions allows Web/Lark to upsert into a single bubble/card. */
export async function projectRunMessageToLedger(
  threadId: string,
  runId: string,
  revision: MessageRevision,
  activeConversations: Set<string>,
  convPort: ConversationPort,
  convSvc: ConversationService,
  /** M17.4: Run kind for dispatch — "reflect" runs are not projected to conversations. */
  kind?: string,
): Promise<void> {
  // M17.4: kind dispatch replaces threadId.startsWith("reflect:").
  if (kind === "reflect") return;
  if (revision.role !== "assistant" && revision.role !== "user") return;

  // M17.2 fix: skip empty revisions (no text, no blocks, no tools) to avoid air bubbles.
  const hasContent =
    (revision.text && revision.text.length > 0) ||
    (revision.blocks && revision.blocks.length > 0) ||
    (revision.tools && revision.tools.length > 0);
  if (!hasContent) return;

  const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
  if (!cid) return;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  const acc = getOrCreateAccumulator(runId, senderMemberId);

  // M17.2: Add conversationId (归属戳) to the framework-assembled revision
  const stamped: MessageRevision = { ...revision, conversationId: cid };

  const ts = Date.now();
  const serialized = serializeMessageRevision(stamped);

  // Dedup: same (runId, serialized) pair
  if (convPort.hasLedgerContent?.(runId, serialized)) return;

  // Update accumulator before writing so onRunComplete has the latest revision
  if (stamped.role === "assistant" && kind !== "reflect") {
    acc.latestAssistantRevision = stamped;
  }

  const seq = convPort.appendLedgerEntry({
    conversationId: cid,
    senderMemberId,
    addressedTo: [],
    kind: "message",
    content: serialized,
    ts,
    runId,
  });
  await convSvc.broadcastMessage(
    {
      seq,
      conversationId: cid,
      senderMemberId,
      addressedTo: [],
      kind: "message",
      content: serialized,
      ts,
    },
    { excludeMemberId: senderMemberId },
  );
}

// ─── Terminal projection helpers ──────────────────────────────

/** Scan the ledger for the latest assistant MessageRevision produced by `runId`.
 *  Used as a fallback when the in-memory RunAccumulator is gone (process restart).
 *  Returns null if no matching revision is found. */
function findLatestAssistantRevision(
  port: ConversationPort,
  conversationId: string,
  runId: string,
): MessageRevision | null {
  const entries = port.getLedgerEntries(conversationId);
  let latest: { rev: MessageRevision; seq: number } | null = null;
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.runId !== runId) continue;
    try {
      const rev = parseMessageRevision(JSON.parse(entry.content));
      if (rev.role === "assistant" && (!latest || entry.seq > latest.seq)) {
        latest = { rev, seq: entry.seq };
      }
    } catch {
      // Malformed entry — skip
    }
  }
  return latest?.rev ?? null;
}

/** M17.4: Check if a terminal revision (done/error) already exists in the ledger
 *  for the given (runId, messageId). Avoids repeated terminal writes when
 *  onRunComplete is invoked multiple times (reaper re-invocation, restart). */
function ledgerHasTerminalForMessage(
  port: ConversationPort,
  conversationId: string,
  runId: string,
  messageId: string,
): boolean {
  const entries = port.getLedgerEntries(conversationId);
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.runId !== runId) continue;
    try {
      const rev = parseMessageRevision(JSON.parse(entry.content));
      if (rev.messageId === messageId && isTerminalMessageState(rev.state)) {
        return true;
      }
    } catch {
      /* malformed entry — skip */
    }
  }
  return false;
}

// ─── Terminal projection (onRunComplete) ──────────────────────

/** Conversation Projection handler: on run complete, await the projection chain,
 *  write a final done/error revision to close the open message, then release the lock
 *  and trigger side effects. Registered as supervisor.onRunComplete listener.
 *
 *  M17.5 P3: Split into three consistency tiers:
 *  Phase 1 (CRITICAL): terminal revision write + broadcast. Failure propagates.
 *  Phase 2 (CRITICAL): lock release in finally — always executes regardless of Phase 1.
 *  Phase 3 (BEST-EFFORT): todo append + @mention triggers — fire-and-forget, each caught. */
export async function onRunComplete(
  threadId: string,
  runId: string,
  status: string,
  convPort: ConversationPort,
  convSvc: ConversationService,
  /** M17.4: Run kind for dispatch — "reflect" runs skip conversation projection. */
  kind?: string,
): Promise<void> {
  if (kind === "reflect") return;

  const { conversationId: cid, memberId: senderMemberId } = parseThreadId(threadId);
  if (!cid) return;

  const acc = runAccumulators.get(runId);

  // ── Phase 1: CRITICAL — terminal revision write + broadcast ──
  try {
    if (acc) {
      try {
        await acc.projectionChain;
      } catch {
        /* chain error already logged */
      }
    }

    const baseRev = acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, runId);
    const frameworkSentTerminal = baseRev != null && isTerminalMessageState(baseRev.state);
    const statusConflict = baseRev?.state === "done" && status !== "succeeded";

    if (!frameworkSentTerminal || statusConflict) {
      const finalRev: MessageRevision = baseRev
        ? {
            ...baseRev,
            // Mapping: run.status → message.state (single authoritative mapping point).
            state: status === "succeeded" ? "done" : "error",
            error: status === "succeeded" ? undefined : { message: status },
            updatedAt: Date.now(),
          }
        : {
            messageId: assistantMessageId(runId, 0),
            role: "assistant",
            state: status === "succeeded" ? "done" : "error",
            text: status === "succeeded" ? "" : `Run failed: ${status}`,
            runId,
            conversationId: cid,
            visibility: "conversation",
            updatedAt: Date.now(),
            error: status === "succeeded" ? undefined : { message: status },
          };

      const messageId = finalRev.messageId;
      if (!ledgerHasTerminalForMessage(convPort, cid, runId, messageId)) {
        const serialized = serializeMessageRevision(finalRev);
        if (!convPort.hasLedgerContent?.(runId, serialized)) {
          const ts = Date.now();
          const seq = convPort.appendLedgerEntry({
            conversationId: cid,
            senderMemberId,
            addressedTo: [],
            kind: "message",
            content: serialized,
            ts,
            runId,
          });
          await convSvc.broadcastMessage(
            { seq, conversationId: cid, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts },
            { excludeMemberId: senderMemberId },
          );
        }
      }
    }
  } catch (err) {
    console.error(
      `[conversation] terminal projection failed for ${runId}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err; // critical failure propagated
  } finally {
    // ── Phase 2: CRITICAL — always release lock regardless of Phase 1 outcome ──
    convSvc.completeRun(cid, threadId, runId);
  }

  // ── Phase 3: BEST-EFFORT — fire-and-forget, each catches independently ──
  if (acc) {
    clearAccumulator(runId);
    if (acc.lastTodoUpdate) {
      void convSvc.appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos).catch((err) =>
        console.error(`[conversation] appendTodo failed for ${runId}:`, err instanceof Error ? err.message : String(err)),
      );
    }
    if (acc.mentionedMemberIds.size > 0) {
      void convSvc.triggerMentionedAgents({
        conversationId: cid,
        senderMemberId: acc.senderMemberId,
        addressedTo: [...acc.mentionedMemberIds],
      }).catch((err) =>
        console.error(`[conversation] triggerMentionedAgents failed for ${runId}:`, err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
