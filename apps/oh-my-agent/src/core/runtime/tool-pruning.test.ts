import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import { estimateMessageTokens } from "./context-estimate.js";
import { pruneOldToolResults } from "./tool-pruning.js";

/** Build a tool message with tool_result content. */
function toolMsg(content: string, toolUseId: string): Message {
  return {
    role: "tool",
    text: content,
    blocks: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}

/** Build an assistant message with tool_use. */
function assistantWithToolUse(_id: string, toolName: string, toolUseId: string): Message {
  return {
    role: "assistant",
    blocks: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
  };
}

describe("pruneOldToolResults", () => {
  test("prunes old tool results outside protect window", () => {
    const bigContent = "x".repeat(4_000);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "bash", "tu1"),
      toolMsg(bigContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(bigContent, "tu2"),
      assistantWithToolUse("a3", "bash", "tu3"),
      toolMsg(bigContent, "tu3"),
    ];

    // The window is deliberately not equal to one result's cost (each is
    // 4000 chars ≈ 1004 tokens with framing): the invariant under test is
    // "results outside the window are pruned, the newest inside it survives",
    // not the arithmetic of a knife-edge boundary.
    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 1_500,
      minimumSavings: 100,
    });

    // Two oldest tool results (tu1, tu2) should be pruned; tu3 stays.
    expect(savedTokens).toBeGreaterThan(0);
    const t1 = messages[1]!;
    const t2 = messages[3]!;
    const t3 = messages[5]!;
    expect(t1.text?.startsWith("[pruned:")).toBe(true);
    expect(t2.text?.startsWith("[pruned:")).toBe(true);
    expect(t3.text?.startsWith("[pruned:")).toBe(false);
  });

  test("protected tools are never pruned", () => {
    const bigContent = "x".repeat(4_000);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "read", "tu1"),
      toolMsg(bigContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(bigContent, "tu2"),
    ];

    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 100,
      minimumSavings: 100,
      protectedTools: new Set(["read"]),
    });

    // read is protected → never pruned; bash is pruned.
    expect(savedTokens).toBeGreaterThan(0);
    expect(messages[1]!.text?.startsWith("[pruned:")).toBe(false);
    expect(messages[3]!.text?.startsWith("[pruned:")).toBe(true);
  });

  test("skips tiny savings below minimumSavings threshold", () => {
    const smallContent = "x".repeat(50);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "bash", "tu1"),
      toolMsg(smallContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(smallContent, "tu2"),
    ];

    const { savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 10,
      minimumSavings: 500,
    });

    expect(savedTokens).toBe(0);
  });

  /** Pruning and the compaction budget must be on ONE scale: a local copy of
   *  the estimator that counted different block types made `savedTokens`
   *  incomparable to the budget the pruner is subtracted from. */
  test("savedTokens are measured with the shared estimator", () => {
    const content = "y".repeat(4_000);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "bash", "tu1"),
      toolMsg(content, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      { role: "user", text: "next" },
    ];
    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 10,
      minimumSavings: 1,
    });
    // The saving it reports must be the shared estimator's difference between
    // the original and the message it actually returned.
    expect(savedTokens).toBe(estimateMessageTokens(msgs[1]!) - estimateMessageTokens(messages[1]!));
  });

  test("no tool messages → unchanged", () => {
    const msgs: Message[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    const { messages, savedTokens } = pruneOldToolResults(msgs);
    expect(messages).toEqual(msgs);
    expect(savedTokens).toBe(0);
  });
});
