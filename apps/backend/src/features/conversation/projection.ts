import type { Message, MessageRevision } from "@my-agent-team/message";
import { assistantMessageId, parseMessageRevision, serializeMessageRevision } from "@my-agent-team/message";
import type { ConversationPort } from "./ports.js";
import type { ConversationService } from "./service.js";

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
  const folded = new Map<string, { role: "user" | "assistant"; rev: ReturnType<typeof parseMessageRevision> }>();
  let legacyDropped = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    try {
      const rev = parseMessageRevision(JSON.parse(entry.content));
      const role = entry.senderMemberId === memberId ? "assistant" : "user";
      folded.set(rev.messageId, { role, rev });
    } catch {
      // Legacy entries without messageId — silently drop but make observable
      legacyDropped++;
    }
  }
  if (legacyDropped > 0) {
    console.warn(
      `[buildPreloadedMessages] dropped ${legacyDropped} legacy ledger row(s) for ${conversationId} — ` +
        `run a migration to rewrite old message rows as MessageRevision.`,
    );
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
   *  Updated on each streaming projection; read by onRunComplete for the final done/error revision. */
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
): Promise<void> {
  // M14.3: reflect runs are not projected to any conversation.
  if (threadId.startsWith("reflect:")) return;
  if (revision.role !== "assistant" && revision.role !== "user") return;

  // M17.2 fix: skip empty revisions (no text, no blocks, no tools) to avoid air bubbles.
  const hasContent =
    (revision.text && revision.text.length > 0) ||
    (revision.blocks && revision.blocks.length > 0) ||
    (revision.tools && revision.tools.length > 0);
  if (!hasContent) return;

  const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
  if (!cid) return;
  const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;

  const acc = getOrCreateAccumulator(runId, senderMemberId);

  // M17.2: Add conversationId (归属戳) to the framework-assembled revision
  const stamped: MessageRevision = { ...revision, conversationId: cid };

  const ts = Date.now();
  const serialized = serializeMessageRevision(stamped);

  // Dedup: same (runId, serialized) pair
  if (convPort.hasLedgerContent?.(runId, serialized)) return;

  // Update accumulator before writing so onRunComplete has the latest revision
  if (stamped.role === "assistant" && !threadId.startsWith("reflect:")) {
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
    { seq, conversationId: cid, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts },
    { excludeMemberId: senderMemberId },
  );
}

// ─── Terminal projection (onRunComplete) ──────────────────────

/** Conversation Projection handler: on run complete, await the projection chain,
 *  write a final done/error revision to close the open message, then release the lock
 *  and trigger side effects. Registered as supervisor.onRunComplete listener. */
export async function onRunComplete(
  threadId: string,
  runId: string,
  status: string,
  activeConversations: Set<string>,
  convPort: ConversationPort,
  convSvc: ConversationService,
): Promise<void> {
  if (threadId.startsWith("reflect:")) return;
  for (const cid of activeConversations) {
    if (threadId.startsWith(`${cid}:`)) {
      const senderMemberId = threadId.includes(":")
        ? (threadId.split(":").pop() as string)
        : threadId;
      const acc = runAccumulators.get(runId);

      // M17: Await the projection chain before writing the terminal revision
      if (acc) {
        try { await acc.projectionChain; } catch { /* chain error already logged */ }
      }

      // M17.2: Framework now emits terminal (state=done/error). Backend writes
      // terminal only as fallback or status-conflict override.
      const baseRev = acc?.latestAssistantRevision ?? null;
      const frameworkSentTerminal = baseRev?.state === "done" || baseRev?.state === "error";
      const statusConflict = baseRev?.state === "done" && status !== "succeeded";
      if (!frameworkSentTerminal || statusConflict) {
        const finalRev: MessageRevision = baseRev
          ? { ...baseRev, state: status === "succeeded" ? "done" : "error", error: status === "succeeded" ? undefined : { message: status }, updatedAt: Date.now() }
          : { messageId: assistantMessageId(runId), role: "assistant", state: status === "succeeded" ? "done" : "error", text: status === "succeeded" ? "" : `Run failed: ${status}`, runId, conversationId: cid, visibility: "conversation", updatedAt: Date.now(), error: status === "succeeded" ? undefined : { message: status } };

        const serialized = serializeMessageRevision(finalRev);
        if (!convPort.hasLedgerContent?.(runId, serialized)) {
          const ts = Date.now();
          const seq = convPort.appendLedgerEntry({ conversationId: cid, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts, runId });
          await convSvc.broadcastMessage(
            { seq, conversationId: cid, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts },
            { excludeMemberId: senderMemberId },
          );
        }
      }

      if (acc) {
        clearAccumulator(runId);
        try {
          if (acc.lastTodoUpdate) {
            await convSvc.appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos);
          }
          if (acc.mentionedMemberIds.size > 0) {
            void convSvc.triggerMentionedAgents({
              conversationId: cid,
              senderMemberId: acc.senderMemberId,
              addressedTo: [...acc.mentionedMemberIds],
            });
          }
        } catch (err) {
          console.error(
            `[conversation] Conversation Projection error for ${runId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      convSvc.completeRun(cid, threadId, runId);
      break;
    }
  }
}
