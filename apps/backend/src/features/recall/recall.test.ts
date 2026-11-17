import { describe, expect, test } from "bun:test";
import type { WorkerCard } from "../product-tools/pool.js";
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

  test("memory and skill are reported as skipped, not as empty", async () => {
    const result = await recall(emptyPorts, { sources: ["memory", "skill", "history"] });
    expect(result.hits).toEqual([]);
    expect(result.skipped).toEqual([
      { source: "memory", reason: "lives in the run's process (oma memory tool)" },
      { source: "skill", reason: "lives in the run's process (skill packs)" },
      { source: "history", reason: "no conversation scope or ledger port" },
    ]);
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
});
