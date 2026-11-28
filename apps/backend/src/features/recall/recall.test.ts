import { describe, expect, test } from "bun:test";
import type { WorkerCard } from "../product-tools/pool.js";
import { extractCues, needsRecall } from "./cues.js";
import { type RecallPorts, recall } from "./recall.js";

function worker(over: Partial<WorkerCard> & { id: string }): WorkerCard {
  return {
    name: over.id,
    description: "",
    skills: [],
    role: "worker",
    activeRuns: 0,
    lastRunAt: 0,
    ...over,
  };
}

const emptyPorts: RecallPorts = {};

describe("ADR 0058 one recall entry for every source", () => {
  test("capability hits carry the agent, the score and the signals", async () => {
    const ports: RecallPorts = {
      workers: async () => [
        worker({ id: "cr", name: "评审工", description: "代码评审与审查" }),
        worker({ id: "fe", name: "前端工", description: "修前端 bug" }),
      ],
    };
    const result = await recall(ports, {
      sources: ["capability"],
      brief: { verb: "review" },
    });
    expect(result.hits[0]).toMatchObject({
      source: "capability",
      ref: "agent:cr",
      meta: { agentId: "cr" },
    });
    expect(result.hits[0]?.score).toBeGreaterThan(0);
    expect(result.hits[0]?.why).toContain("verb review");
    expect(result.searched).toEqual([
      { source: "capability", hits: 2, detail: "2 eligible worker(s)" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  test("memory without a port is reported as skipped, not as empty", async () => {
    // ADR 0064: memory became reachable, so the reason changed from "lives in
    // the child" to "this deployment wired no port". Skill is still the child.
    const result = await recall(emptyPorts, { sources: ["memory", "skill", "history"] });
    expect(result.hits).toEqual([]);
    expect(result.skipped).toEqual([
      {
        source: "memory",
        reason: "no memory port wired (the agent's .oma/memory is unreachable here)",
      },
      { source: "skill", reason: "lives in the run's process (skill packs)" },
      { source: "history", reason: "no conversation scope or ledger port" },
    ]);
  });

  test("memory with a port is searched, and its hits carry a citable ref", async () => {
    const result = await recall(
      {
        searchMemory: async () => [
          {
            id: "m1",
            content: "登录重定向死循环：两个分支都返回 /login",
            source: "learn",
            at: 1000,
            why: "fts",
          },
        ],
      },
      { sources: ["memory"], conversationId: "c1", text: "登录一直转圈" },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ source: "memory", ref: "mem:m1", at: 1000 });
    expect(result.searched.find((s) => s.source === "memory")?.hits).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  test("a message with no cues says it did not look, rather than 'nothing found'", async () => {
    const result = await recall(
      { searchLedger: () => [] },
      { sources: ["history"], conversationId: "c1", text: "把安装步骤补上" },
    );
    expect(result.searched).toEqual([
      { source: "history", hits: 0, detail: "no reference cues — not searched" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  test("history and qa share the manifest and keep their provenance", async () => {
    const ports: RecallPorts = {
      searchLedger: () => [{ seq: 412, ts: 9, snippet: "上次用的 release/2026-11" }],
      listActions: async () => [
        {
          actionId: "a1",
          kind: "ask",
          status: "resolved",
          payload: { questions: [{ question: "要不要动生产？" }] },
          response: { answers: [{ selectedValues: ["不要"], freeText: "" }] },
          createdAt: 5,
        },
      ],
    };
    const result = await recall(ports, {
      sources: ["qa", "history"],
      conversationId: "c1",
      text: "上次那个分支",
    });
    expect(result.hits.map((h) => h.ref)).toEqual(["action:a1", "seq:412"]);
    expect(result.searched.map((s) => s.source)).toEqual(["qa", "history"]);
  });

  test("the cap is the caller's, not a silently larger default", async () => {
    const ports: RecallPorts = {
      searchLedger: () =>
        Array.from({ length: 20 }, (_, i) => ({ seq: i, ts: i, snippet: `h${i}` })),
    };
    const result = await recall(ports, {
      sources: ["history"],
      conversationId: "c1",
      text: "上次那个",
      limit: 2,
    });
    expect(result.hits).toHaveLength(2);
  });

  test("English pronoun cues require word boundaries and do not trigger on ordinary words", () => {
    const clean = extractCues("write a test with commit and edit history status");
    expect(clean.cues).toEqual([]);
    expect(needsRecall(clean)).toBe(false);

    const fixIt = extractCues("fix it");
    expect(fixIt.cues).toContain("it");
    expect(needsRecall(fixIt)).toBe(true);
    expect(extractCues("check that earlier error").cues).toContain("that");
    expect(extractCues("上次那个分支").cues).toContain("上次");
  });
});
