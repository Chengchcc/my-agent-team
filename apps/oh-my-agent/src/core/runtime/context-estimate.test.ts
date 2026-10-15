import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import {
  compactReserveTokens,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
  isSilentContextOverflow,
  triggerRatioFor,
  type UsageAnchor,
  usageTotalTokens,
} from "./context-estimate.js";

describe("estimateContextTokens (usage-anchored, oh-my-pi)", () => {
  const entries = [
    { entryId: "a", est: 100 },
    { entryId: "b", est: 200 },
    { entryId: "c", est: 300 },
  ];
  const estimateEntry = (e: { est: number }) => e.est;

  test("no anchor: full per-entry estimation", () => {
    expect(estimateContextTokens(entries, null, estimateEntry)).toBe(600);
  });

  test("anchor replaces everything up to and including the boundary entry", () => {
    const anchor: UsageAnchor = { afterEntryId: "b", tokens: 1000 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(1300);
  });

  test("anchor at last entry covers the whole branch", () => {
    const anchor: UsageAnchor = { afterEntryId: "c", tokens: 42 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(42);
  });

  test("anchor boundary entry gone (post-compaction) falls back to full estimate", () => {
    const anchor: UsageAnchor = { afterEntryId: "zzz", tokens: 1000 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(600);
  });

  test("null boundary (empty branch at call time) anchors everything", () => {
    const anchor: UsageAnchor = { afterEntryId: null, tokens: 500 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(1100);
  });
});

describe("isSilentContextOverflow (oh-my-pi)", () => {
  test("zai-style: input side over the window on a successful turn", () => {
    expect(
      isSilentContextOverflow({ inputTokens: 5000, cacheReadTokens: 0 }, "end_turn", 4000),
    ).toBe(true);
  });

  test("cacheRead counts toward the input side", () => {
    expect(isSilentContextOverflow({ inputTokens: 100, cacheReadTokens: 3950 }, "stop", 4000)).toBe(
      true,
    );
  });

  test("normal in-window usage is not overflow", () => {
    expect(isSilentContextOverflow({ inputTokens: 3000, outputTokens: 10 }, "end_turn", 4000)).toBe(
      false,
    );
  });

  test("xiaomi-style: length-stop with zero output filling the window", () => {
    expect(
      isSilentContextOverflow(
        { inputTokens: 3980, outputTokens: 0, cacheReadTokens: 0 },
        "max_tokens",
        4000,
      ),
    ).toBe(true);
    // output > 0 means generation happened: not a silent overflow
    expect(
      isSilentContextOverflow(
        { inputTokens: 3980, outputTokens: 5, cacheReadTokens: 0 },
        "max_tokens",
        4000,
      ),
    ).toBe(false);
  });

  test("no usage or non-positive limit never overflows", () => {
    expect(isSilentContextOverflow(undefined, "end_turn", 4000)).toBe(false);
    expect(isSilentContextOverflow({ inputTokens: 9999 }, "end_turn", 0)).toBe(false);
  });
});

/** One estimator for the compaction budget AND tool-result pruning. The old
 *  pair disagreed on tool messages: one counted `text` (the UI's clean copy)
 *  AND the tool_result block (the same payload), so the tool-heavy turns that
 *  dominate a long run were estimated at ~2x. These cases pin the wire
 *  mapping in packages/ai/.../anthropic-messages.ts, not just a number. */
describe("estimateMessageTokens (wire-accurate)", () => {
  test("a tool message counts its tool_result ONCE, never text + block", () => {
    const content = "x".repeat(40);
    const msg: Message = {
      role: "tool",
      text: content,
      blocks: [{ type: "tool_result", tool_use_id: "tu1", content }],
    };
    // 40 chars / 4 = 10, + 4 framing. A second copy of `text` would give 24.
    expect(estimateMessageTokens(msg)).toBe(14);
  });

  test("an assistant message without a text block still counts its text", () => {
    // The adapter appends `text` as a trailing text block, so it reaches the
    // model and must be counted.
    const msg: Message = {
      role: "assistant",
      text: "efgh",
      blocks: [{ type: "thinking", text: "abcd" }],
    };
    expect(estimateMessageTokens(msg)).toBe(6); // (4 + 4)/4 + 4
  });

  test("a text block already carrying the text is not counted twice", () => {
    const msg: Message = {
      role: "assistant",
      text: "efgh",
      blocks: [{ type: "text", text: "efgh" }],
    };
    expect(estimateMessageTokens(msg)).toBe(5); // 4/4 + 4
  });

  test("no blocks falls back to text", () => {
    expect(estimateMessageTokens({ role: "user", text: "abcdefgh" })).toBe(6);
    expect(estimateMessageTokens({ role: "user" })).toBe(4);
  });

  test("tool_use input and a thinking signature are counted", () => {
    const msg: Message = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "", signature: "abcd" },
        { type: "tool_use", id: "t", name: "bash", input: { description: "xxxxxxxx" } },
      ],
    };
    // signature 4 + JSON.stringify({description:"xxxxxxxx"}) = 26 chars.
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(30 / 4) + 4);
  });

  test("image payloads do not inflate the estimate", () => {
    // base64 is ~1.33 chars/byte while an image costs ~1 token per 750 bytes;
    // char/4 would over-count by ~1000x and compact far too early.
    const msg: Message = {
      role: "user",
      blocks: [{ type: "image", mediaType: "image/png", base64: "A".repeat(40_000) }],
    };
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  test("CJK weighs ~1.5 chars/token — chars/4 under-counts 2-4x and wedges overflow recovery", () => {
    // The dangerous direction is UNDER-estimation: the threshold gate thinks
    // "under budget" while the provider overflows, so the recovery's own cut
    // math no-ops and the retry 400s again (one-shot guard = wedged run).
    // Chinese runs ~1-1.5 chars/token (deepseek's own docs: ~1.5).
    const cjk = estimateMessageTokens({ role: "user", text: "检".repeat(100) });
    const ascii = estimateMessageTokens({ role: "user", text: "x".repeat(100) });
    expect(ascii).toBe(Math.ceil(100 / 4) + 4);
    expect(cjk).toBe(Math.ceil((100 * 2) / 3) + 4);
    // Mixed runs are prorated, not max-ed.
    expect(estimateTextTokens("检查x")).toBeCloseTo((2 * 2) / 3 + 1 / 4, 5);
  });
});

describe("compaction trigger reserve (omp-shaped)", () => {
  test("a large window holds back 15% — not a fixed share of it", () => {
    // 200k: 30k reserved => the trigger sits at 85%, where the old 0.7 held
    // back 60k that a 200k window never needs.
    expect(compactReserveTokens(200_000)).toBe(30_000);
    expect(triggerRatioFor(200_000)).toBeCloseTo(0.85, 5);
  });

  test("a mid window gets the 16384 floor, not a fraction of a huge window", () => {
    expect(compactReserveTokens(60_000)).toBe(16_384);
    expect(triggerRatioFor(60_000)).toBeCloseTo(1 - 16_384 / 60_000, 5);
  });

  test("a window too small for the floor gives up at most half of itself", () => {
    expect(compactReserveTokens(8_000)).toBe(4_000);
    expect(triggerRatioFor(8_000)).toBeCloseTo(0.5, 5);
    // Never more than the window can spare, and never a negative trigger.
    expect(compactReserveTokens(1_000)).toBe(500);
  });

  test("an explicit reserve is honoured, but cannot eat the whole window", () => {
    expect(compactReserveTokens(200_000, 40_000)).toBe(40_000);
    expect(triggerRatioFor(200_000, 40_000)).toBeCloseTo(0.8, 5);
    expect(compactReserveTokens(1_000, 5_000)).toBe(999);
    expect(triggerRatioFor(1_000, 5_000)).toBeCloseTo(0.001, 5);
  });

  test("an unknown window keeps the old fixed default", () => {
    expect(triggerRatioFor(0)).toBe(0.7);
    expect(triggerRatioFor(-1)).toBe(0.7);
  });
});

describe("usageTotalTokens", () => {
  test("sums all four legs", () => {
    expect(
      usageTotalTokens({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      }),
    ).toBe(116);
  });
});
