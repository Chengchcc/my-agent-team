import type { Message } from "@chengchenccc/message";

/** Context-token estimation helpers absorbed from oh-my-pi
 * (packages/agent/src/harness/compaction/compaction.ts):
 * usage-anchored estimation + silent-overflow detection. */

/** Per-message framing overhead (role tag, separators — matches Anthropic's
 *  documented ~4 tokens/message). */
const MESSAGE_FRAMING_TOKENS = 4;

/** CJK code points (BMP): unified + ext-A + compat ideographs, kana, hangul,
 *  CJK punctuation and fullwidth forms. Astral-plane ideographs (ext B+) are
 *  rare in chat and count via their 2 UTF-16 units — the wrong direction is
 *  under-counting, and 2 units of "other" at /4 is still a lower bound. */
const CJK_RE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/g;

/** Token estimate of ONE text run, CJK-aware.
 *
 *  chars/4 is the English/code proxy (≈4 chars/token). For CJK it
 *  UNDER-counts 2-4× (Chinese ≈ 1-1.5 chars/token — deepseek's own docs put
 *  it at ~1.5), and under-counting is the dangerous direction for a compaction
 *  trigger: the estimate says "under budget" while the provider is already
 *  overflowing, so the recovery's own cut math no-ops and the retry 400s again
 *  (one-shot guard) — a terminally wedged run. CJK is therefore weighted at
 *  1.5 chars/token. The usage anchor remains the real corrector while a run
 *  streams; this only needs to be right-side-of-the-line after a resume. */
export function estimateTextTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return (cjk * 2) / 3 + (text.length - cjk) / 4;
}

/** Approximate token cost of ONE message as it will be SENT to the provider.
 *
 *  The single estimator for both the compaction budget and tool-result pruning:
 *  two divergent copies meant the trigger and the pruning window measured
 *  different quantities (one counted `text` AND `blocks`, which for a tool
 *  message is the same payload twice), so pruning's "saved tokens" were not
 *  comparable to the budget they were subtracted from.
 *
 *  What is counted mirrors the wire mapping in
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
 *  Swap for a real tokenizer by replacing estimateTextTokens —
 *  `ContextBudget.estimate` stays the extension point. */
export function estimateMessageTokens(message: Message): number {
  const blocks = message.blocks ?? [];
  if (blocks.length === 0) {
    return Math.ceil(estimateTextTokens(message.text ?? "")) + MESSAGE_FRAMING_TOKENS;
  }
  let tokens = 0;
  let carriesText = false;
  for (const b of blocks) {
    if (b.type === "text") {
      tokens += estimateTextTokens(b.text);
      carriesText = true;
    } else if (b.type === "thinking") {
      tokens += estimateTextTokens(b.text + (b.signature ?? ""));
    } else if (b.type === "tool_use") {
      tokens += estimateTextTokens(JSON.stringify(b.input));
    } else if (b.type === "tool_result") {
      tokens += estimateTextTokens(b.content);
    }
  }
  if (message.role !== "tool" && !carriesText && message.text) {
    tokens += estimateTextTokens(message.text);
  }
  return Math.ceil(tokens) + MESSAGE_FRAMING_TOKENS;
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

/** Tokens held back for the next model call: its output plus the tool results
 *  that output triggers. Mirrors omp's default reserve (a 16384-token floor
 *  with at least 15% of the window), read as: `clamp(0.15 * window, floor)` —
 *  except on a window small enough that the floor would swallow it, where the
 *  proportional reserve is used instead. */
export const DEFAULT_COMPACT_RESERVE_TOKENS = 16_384;

/** The reserve itself, in tokens. An explicit override wins (omp: "an explicit
 *  configured reserve is honored") as long as it leaves something to work in. */
export function compactReserveTokens(contextWindow: number, override?: number): number {
  if (override !== undefined && override > 0) {
    return Math.min(override, Math.max(1, contextWindow - 1));
  }
  const proportional = Math.round(contextWindow * 0.15);
  const reserved = Math.max(proportional, DEFAULT_COMPACT_RESERVE_TOKENS);
  // A window small enough for the floor to swallow it still gives up as much as
  // it can spare. Deliberate divergence from omp, which falls back to the 15%
  // proportion there: omp's windows are large in practice, while this runtime
  // also drives small local models, and the reserve must cover the next output
  // plus the tool results it triggers — neither shrinks with the window. The
  // override above covers anyone who prefers the proportion.
  return Math.min(reserved, Math.round(contextWindow / 2));
}

/** The compaction trigger as a ratio of the context window.
 *
 *  The loop triggers at `limit * triggerRatio`, so this is where the reserve
 *  becomes one. A FIXED ratio (the old 0.7) scales the headroom WITH the
 *  window: 60k of a 200k window it will never need, while an 8k window holds
 *  back barely one tool result. What the headroom has to cover — the next
 *  output plus its tool results — is an addition, not a proportion.
 *
 *  A window we cannot know keeps the old default. */
export function triggerRatioFor(contextWindow: number, reserveOverride?: number): number {
  if (!(contextWindow > 0)) return 0.7;
  return 1 - compactReserveTokens(contextWindow, reserveOverride) / contextWindow;
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
