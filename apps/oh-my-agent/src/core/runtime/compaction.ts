import type { Message } from "@chengchenccc/message";
import type { SessionStore } from "../store/session-store.js";
import type { CodingSessionEntry } from "../store/session-tree.js";

export interface CompactionResult {
  readonly entryId: string;
  readonly coveredIds: readonly string[];
}

/** Token budget used for compaction cut points. `estimate` is a per-message
 *  token cost; `limit` is the target ceiling for the retained context. */
export interface CompactionBudget {
  estimate(message: Message): number;
  limit: number;
}

/** If the cut lands between an assistant tool_use and its tool_result,
 *  move the cut before the assistant so the pair stays intact. */
function adjustCutForToolPairs(messages: readonly CodingSessionEntry[], cutIdx: number): number {
  let cut = cutIdx;
  while (cut < messages.length && messages[cut]?.type === "message") {
    const first = messages[cut] as {
      role?: string;
      message?: { blocks?: Array<{ type?: string; tool_use_id?: string }> };
    };
    if (first.role !== "tool") break;
    const toolUseId = first.message?.blocks?.find((b) => b.type === "tool_result")?.tool_use_id;
    if (!toolUseId) break;
    let assocIdx = -1;
    for (let i = 0; i < cut; i++) {
      const m = messages[i] as {
        role?: string;
        message?: { blocks?: Array<{ type?: string; id?: string }> };
      };
      if (
        m.role === "assistant" &&
        m.message?.blocks?.some((b) => b.type === "tool_use" && b.id === toolUseId)
      ) {
        assocIdx = i;
      }
    }
    if (assocIdx === -1) break;
    cut = assocIdx;
    break;
  }
  return cut;
}

/** The latest compaction in a branch, if any: its summary and the entry ids it
 *  covered. Single source for "which entries are still live" — the branch
 *  rebuild (agent-loop-run) and the threshold estimator (agent-loop-runner)
 *  must agree, or the estimator counts entries the model no longer receives. */
export function latestCompaction(entries: readonly CodingSessionEntry[]): {
  summary: string;
  coveredIds: ReadonlySet<string>;
} | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "compaction") {
      return { summary: e.summary, coveredIds: new Set(e.coversEntryIds) };
    }
  }
  return null;
}

interface CutPlan {
  cutIdx: number;
  tokensBefore?: number;
}

/** Compute the compaction cut point. Always returns a value: without a budget
 *  it uses a message-count heuristic; with a budget it accumulates tokens from
 *  the oldest messages until the retained tail fits under the limit. When the
 *  context is already under the limit, cutIdx is 0 (no compaction needed). */
function findCut(messages: readonly CodingSessionEntry[], budget?: CompactionBudget): CutPlan {
  if (!budget) {
    return { cutIdx: Math.floor(messages.length * 0.6) };
  }
  const tokens = messages.map((m) => budget.estimate((m as { message: Message }).message));
  const tokensBefore = tokens.reduce((sum, t) => sum + t, 0);
  if (tokensBefore <= budget.limit) {
    return { cutIdx: 0, tokensBefore };
  }
  let remaining = tokensBefore;
  let cutIdx = 0;
  while (cutIdx < messages.length && remaining > budget.limit) {
    remaining -= tokens[cutIdx]!;
    cutIdx++;
  }
  // Never cover the newest message. The summary is prepended to whatever
  // survives, so a cut that covers everything leaves the model with an empty
  // conversation — not even the summary. One oversized entry (a huge
  // tool_result is enough) drives cutIdx to messages.length without this.
  cutIdx = Math.min(cutIdx, messages.length - 1);
  return { cutIdx, tokensBefore };
}

/** Compact a session branch: summarize oldest entries, append CompactionEntry,
 *  leave tail entries intact. Shared by threshold/manual/overflow triggers.
 *
 *  The summarizer receives full Message objects (including tool_use/tool_result
 *  blocks) so tool semantics survive compaction. The AbortSignal lets stop()
 *  cancel an in-flight summarizer; an aborted compaction writes nothing.
 *  No-op when the context is already under budget (no summarizer call, no
 *  CompactionEntry), and never writes an entry with empty coversEntryIds. */
export async function compactSession(
  store: SessionStore,
  sessionId: string,
  summarizer: (messages: readonly Message[], signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
  budget?: CompactionBudget,
): Promise<CompactionResult> {
  const branch = await store.readBranch(sessionId);
  const messages = branch.filter((e) => e.type === "message");
  if (messages.length < 4) return { entryId: "", coveredIds: [] };

  const { cutIdx: rawCutIdx, tokensBefore } = findCut(messages, budget);
  let cutIdx = rawCutIdx;
  cutIdx = adjustCutForToolPairs(messages, cutIdx);

  // No compaction needed: nothing to cover (under budget or cut collapsed).
  if (cutIdx <= 0) return { entryId: "", coveredIds: [] };

  const coveredEntries = messages.slice(0, cutIdx);
  const coveredIds = coveredEntries.map((m) => m.entryId);
  const retainedIds = messages.slice(cutIdx).map((m) => m.entryId);
  const coveredMessages = coveredEntries.map((m) => (m as { message: Message }).message);

  const alreadyCovered = latestCompaction(branch)?.coveredIds;
  if (alreadyCovered && coveredIds.every((id) => alreadyCovered.has(id))) {
    return { entryId: "", coveredIds: [] };
  }
  // The no-progress guard: a cut that covers nothing new (everything it would
  // cover is already covered by an earlier compaction) buys nothing and would
  // append an identical CompactionEntry on every loop iteration. This is what
  // lets the loop trigger compaction purely on the budget — there is no
  // "already compacted" flag to get stuck in, because compaction itself is the
  // thing that decides whether it can still do useful work.

  const summary = await summarizer(coveredMessages, signal);

  // If aborted during summarization, do not write a CompactionEntry.
  if (signal?.aborted) return { entryId: "", coveredIds: [] };

  const result = await store.appendBatch(sessionId, {
    entries: [
      {
        type: "compaction",
        summary,
        coversEntryIds: coveredIds,
        ...(budget ? { tokensBefore, retainedEntryIds: retainedIds } : {}),
        createdAt: Date.now(),
      },
    ],
  });

  return {
    entryId: result.appendedIds[0] ?? "",
    coveredIds: coveredIds,
  };
}
