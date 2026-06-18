import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  assistantMessageId,
  deserializeLedgerContent,
  isSucceededMessageState,
  isTerminalMessageState,
  type parseMessageRevision,
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
    const parsed = deserializeLedgerContent(entry.content);
    if (!("messageId" in parsed)) continue; // legacy or malformed — skip
    const role = entry.senderMemberId === memberId ? "assistant" : "user";
    folded.set(parsed.messageId, { role, rev: parsed });
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
   *  Updated by onRunMessage callback; read by onRunComplete for the final done/error revision.
   *  M17.4: This is an optimization — if the process restarts and the accumulator is gone,
   *  onRunComplete falls back to scanning the ledger.
   *  M17.5 P7: Updated directly in main.ts onRunMessage instead of via projectionChain. */
  latestAssistantRevision: MessageRevision | null;
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
    };
    runAccumulators.set(runId, acc);
  }
  return acc;
}

export function clearAccumulator(runId: string): void {
  runAccumulators.delete(runId);
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
    const parsed = deserializeLedgerContent(entry.content);
    if (!("messageId" in parsed)) continue;
    if (parsed.role === "assistant" && (!latest || entry.seq > latest.seq)) {
      latest = { rev: parsed, seq: entry.seq };
    }
  }
  return latest?.rev ?? null;
}

/** Check if a terminal revision (done/error) already exists in the ledger
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
    const parsed = deserializeLedgerContent(entry.content);
    if (!("messageId" in parsed)) continue;
    if (parsed.messageId === messageId && isTerminalMessageState(parsed.state)) {
      return true;
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

/** Run-completion handler. Supervisor AWAITS this — failure propagates (critical sink).
 *  P1: run_finalized already sent before this, so await doesn't block control signal.
 *
 *  Phase 1 (CRITICAL): terminal revision write + broadcast. Throws on failure.
 *  Phase 2 (CRITICAL finally): lock release — always executes.
 *  Phase 3 (BEST-EFFORT): todo append + @mention triggers — fire-and-forget, each caught. */
export async function onRunComplete(
  threadId: string,
  runId: string,
  status: string,
  convPort: ConversationPort,
  convSvc: ConversationService,
  kind?: string,
): Promise<void> {
  if (kind === "reflect") return;

  const { conversationId: cid, memberId: senderMemberId } = parseThreadId(threadId);
  if (!cid) return;

  const acc = runAccumulators.get(runId);

  // ── Phase 1: CRITICAL — terminal revision write + broadcast ──
  try {
    const baseRev =
      acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, runId);
    const frameworkSentTerminal = baseRev != null && isTerminalMessageState(baseRev.state);
    const statusConflict =
      baseRev != null && isSucceededMessageState(baseRev.state) && status !== "succeeded";

    if (!frameworkSentTerminal || statusConflict) {
      const finalRev: MessageRevision = baseRev
        ? {
            ...baseRev,
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
      }
    }
  } catch (err) {
    console.error(
      `[conversation] terminal projection failed for ${runId}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err; // critical failure propagated — supervisor catches and logs
  } finally {
    // Phase 2: lock release always executes.
    convSvc.completeRun(cid, threadId, runId);
  }

  // ── Phase 3: BEST-EFFORT — fire-and-forget, each catches independently ──
  if (acc) {
    clearAccumulator(runId);
    if (acc.lastTodoUpdate) {
      void convSvc
        .appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos)
        .catch((err) =>
          console.error(
            `[conversation] appendTodo failed for ${runId}:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
    if (acc.mentionedMemberIds.size > 0) {
      void convSvc
        .triggerMentionedAgents({
          conversationId: cid,
          senderMemberId: acc.senderMemberId,
          addressedTo: [...acc.mentionedMemberIds],
        })
        .catch((err) =>
          console.error(
            `[conversation] triggerMentionedAgents failed for ${runId}:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
  }
}
