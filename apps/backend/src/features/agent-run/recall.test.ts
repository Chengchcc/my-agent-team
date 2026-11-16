import { describe, expect, test } from "bun:test";
import {
  collectRecall,
  extractCues,
  needsRecall,
  type RecallPorts,
  renderRecallBlock,
} from "./recall.js";

describe("ADR 0055 recall as an input to intent recognition", () => {
  test("a standalone message triggers nothing (the common case stays free)", () => {
    // No pronoun, no pointer: the sentence stands on its own. (README would
    // count as an identifier — uppercase alone is enough to be worth a lookup.)
    const cues = extractCues("把安装步骤补上");
    expect(needsRecall(cues)).toBe(false);
  });

  test("pronouns and back-references trigger it", () => {
    for (const text of [
      "那个还没修好吗",
      "上次说的方案呢",
      "can you do the same for the other one",
    ]) {
      expect(needsRecall(extractCues(text))).toBe(true);
    }
  });

  test("identifiers alone are enough — they are already pointers", () => {
    const cues = extractCues("看下 seq:412 那次改动");
    expect(cues.identifiers).toContain("seq:412");
    expect(needsRecall(cues)).toBe(true);
    expect(cues.query).toContain("seq:412");
  });

  test("the query prefers identifiers over the sentence", () => {
    const cues = extractCues("那个 PR #123 的 src/auth/login.ts 问题");
    expect(cues.query).toContain("#123");
    expect(cues.query).toContain("src/auth/login.ts");
  });

  test("the block prints what was searched even when nothing matched", () => {
    const block = renderRecallBlock({
      hits: [],
      searched: [
        { source: "qa", hits: 0 },
        { source: "history", hits: 0 },
      ],
    });
    expect(block).toContain("qa=0, history=0");
    expect(block).toContain("do not invent, ask the human");
  });

  test("every hit carries source, ref, date and why", () => {
    const block = renderRecallBlock({
      hits: [
        {
          source: "history",
          ref: "seq:412",
          at: Date.UTC(2026, 10, 14),
          text: "用户要求登录页保持记住我默认勾选",
          why: "上次",
        },
      ],
      searched: [{ source: "history", hits: 1 }],
    });
    expect(block).toContain("[history seq:412, 2026-11-14]");
    expect(block).toContain("matched: 上次");
    expect(block).toContain("stale");
  });

  const qaPort: RecallPorts = {
    listActions: async () => [
      {
        actionId: "a1",
        kind: "ask",
        status: "resolved",
        payload: { questions: [{ question: "要不要动生产？" }] },
        response: { answers: [{ selectedValues: ["不要"], freeText: "" }] },
        createdAt: 1,
      },
      {
        actionId: "a2",
        kind: "ask",
        status: "pending",
        payload: { questions: [{ question: "用哪个分支？" }] },
        response: null,
        createdAt: 2,
      },
    ],
    searchLedger: () => [],
  };

  test("answered and still-open questions are pinned into the recall", async () => {
    const result = await collectRecall(qaPort, { conversationId: "c1", text: "那个呢？" });
    const texts = result.hits.map((h) => h.text);
    expect(texts).toContain("Q: 要不要动生产？ A: 不要");
    expect(texts).toContain("Q: 用哪个分支？ (still unanswered)");
    expect(result.hits.every((h) => h.source === "qa")).toBe(true);
  });

  test("history is scoped to this conversation and keeps its seq as provenance", async () => {
    const seen: Array<{ keyword: string; scope?: { conversationId?: string } }> = [];
    const ports: RecallPorts = {
      listActions: async () => [],
      searchLedger: (keyword, _limit, scope) => {
        seen.push({ keyword, scope });
        return [{ seq: 412, ts: 9, snippet: "上次的登录修复用到了 src/auth" }];
      },
    };
    const result = await collectRecall(ports, { conversationId: "c1", text: "上次那个" });
    expect(seen[0]?.scope).toEqual({ conversationId: "c1" });
    expect(result.hits[0]).toMatchObject({ source: "history", ref: "seq:412" });
  });

  test("no cues means no ports are touched at all", async () => {
    let called = false;
    const ports: RecallPorts = {
      listActions: async () => {
        called = true;
        return [];
      },
      searchLedger: () => {
        called = true;
        return [];
      },
    };
    const result = await collectRecall(ports, { conversationId: "c1", text: "加个测试" });
    expect(called).toBe(false);
    expect(result.hits).toEqual([]);
    expect(result.searched).toEqual([{ source: "cues", hits: 0 }]);
  });

  test("hits are capped so recall cannot flood the context", async () => {
    const ports: RecallPorts = {
      listActions: async () => [],
      searchLedger: () =>
        Array.from({ length: 20 }, (_, i) => ({ seq: i, ts: i, snippet: `hit ${i}` })),
    };
    const result = await collectRecall(ports, { conversationId: "c1", text: "上次那个" });
    expect(result.hits.length).toBeLessThanOrEqual(6);
  });
});
