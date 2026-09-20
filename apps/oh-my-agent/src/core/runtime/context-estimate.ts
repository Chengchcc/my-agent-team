import type { Message } from "@chengchenccc/message";

/** Context-token estimation helpers absorbed from oh-my-pi
 * (packages/agent/src/harness/compaction/compaction.ts):
 * usage-anchored estimation + silent-overflow detection. */

/** Per-message framing overhead (role tag, separators — matches Anthropic's
 *  documented ~4 tokens/message). */
const MESSAGE_FRAMING_TOKENS = 4;

/** Approximate token cost of ONE message as it will be SENT to the provider.
 *
 *  The single estimator for both the compaction budget and tool-result pruning:
 *  two divergent copies meant the trigger and the pruning window measured
 *  different quantities (one counted `text` AND `blocks`, which for a tool
 *  message is the same payload twice), so pruning's "saved tokens" were not
 *  comparable to the budget they were subtracted from.
 *
 *  Char/4 is the documented proxy (≈4 chars/token for English/code). What is
 *  counted mirrors the wire mapping in
 *  packages/ai/src/providers/anthropic-messages.ts:
 *  - a `tool` message sends ONLY its tool_result blocks (`text` is the UI's
 *    clean copy), so counting `text` as well would double it;
 *  - every other role sends `text` as a trailing text block unless a text block
 *    already carries it;
 *  - image payloads are ignored: providers price an image by its PIXEL
 *    dimensions (~width*height/750 tokens), not by the base64 length, so
 *    char/4 over the encoded bytes would over-count it by a size-dependent
 *    factor and compact far too early.
 *
 *  Swap for a real tokenizer by replacing this function — `ContextBudget.estimate`
 *  stays the extension point. */
export function estimateMessageTokens(message: Message): number {
  const blocks = message.blocks ?? [];
  if (blocks.length === 0) {
    return Math.ceil((message.text?.length ?? 0) / 4) + MESSAGE_FRAMING_TOKENS;
  }
  let chars = 0;
  let carriesText = false;
  for (const b of blocks) {
    if (b.type === "text") {
      chars += b.text.length;
      carriesText = true;
    } else if (b.type === "thinking") {
      chars += b.text.length + (b.signature?.length ?? 0);
    } else if (b.type === "tool_use") {
      chars += JSON.stringify(b.input).length;
    } else if (b.type === "tool_result") {
      chars += b.content.length;
    }
  }
  if (message.role !== "tool" && !carriesText && message.text) chars += message.text.length;
  return Math.ceil(chars / 4) + MESSAGE_FRAMING_TOKENS;
}

/** Per-turn usage quartet (concrete, unlike the all-optional run Usage). */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** A real-usage anchor: `tokens` is a completed model call's own total
 * (input + output + cache legs) and is authoritative for every entry
 * persisted before `afterEntryId`; only entries AFTER it fall back to
 * per-message estimation (chars/4). Falls back wholesale when the anchor
 * entry itself no longer exists — the loop clears the anchor when it
 * compacts and re-anchors on the next call, so today that is reachable only
 * for an out-of-band compaction of the same branch.
 *
 * ponytail: the anchor is in-memory per Run — pi persists usage on
 * assistant messages and re-anchors after resume. Persist it onto the
 * session file if follow-up Runs ever drift badly. */
export interface UsageAnchor {
  readonly afterEntryId: string | null;
  readonly tokens: number;
}

export function usageTotalTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Context size estimate anchored on the last real usage: anchor tokens +
 * per-entry estimates for entries persisted after the anchor boundary.
 * Without an anchor (or when the boundary entry is gone) every entry is
 * estimated — the pre-anchor behavior. */
export function estimateContextTokens<T extends { entryId: string }>(
  entries: readonly T[],
  anchor: UsageAnchor | null,
  estimateEntry: (entry: T) => number,
): number {
  const fallback = (): number => entries.reduce((sum, e) => sum + estimateEntry(e), 0);
  if (!anchor) return fallback();
  const idx =
    anchor.afterEntryId === null ? -1 : entries.findIndex((e) => e.entryId === anchor.afterEntryId);
  if (anchor.afterEntryId !== null && idx === -1) return fallback();
  return anchor.tokens + entries.slice(idx + 1).reduce((sum, e) => sum + estimateEntry(e), 0);
}

/** Silent context overflow (oh-my-pi isContextOverflow): some providers
 * accept an oversized request instead of erroring.
 * - zai-style: the input side exceeds the model window — never legitimate.
 * - Xiaomi-style: input truncated to exactly fill the window, leaving zero
 *   room to generate (length-stop with zero output). */
export function isSilentContextOverflow(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined,
  stopReason: string | undefined,
  contextLimit: number,
): boolean {
  if (!usage || contextLimit <= 0) return false;
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  if (input <= 0) return false;
  if (input > contextLimit) return true;
  return (
    stopReason === "max_tokens" && (usage.outputTokens ?? 0) === 0 && input >= contextLimit * 0.99
  );
}
