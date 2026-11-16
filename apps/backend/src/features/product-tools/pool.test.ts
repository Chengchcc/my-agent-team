import { describe, expect, test } from "bun:test";
import { describePick, recallWorkers, type WorkerCard } from "./pool.js";

function card(over: Partial<WorkerCard> & { id: string }): WorkerCard {
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

describe("ADR 0056 worker selection is a capability recall", () => {
  test("the brief's verb ranks a card that actually does that work", () => {
    const recall = recallWorkers(
      [
        card({ id: "fe", description: "修前端 bug", skills: ["react"] }),
        card({ id: "cr", description: "代码评审与质量把关", skills: ["review"] }),
      ],
      { verb: "review" },
    );
    expect(recall.hits[0]?.agentId).toBe("cr");
    expect(recall.hits[0]?.why.join(" ")).toContain("verb review");
  });

  test("before this, a review could land on the bug fixer — now it cannot outrank", () => {
    const recall = recallWorkers(
      [
        card({ id: "fixer", description: "修 bug", skills: ["react"], activeRuns: 0 }),
        card({ id: "reviewer", description: "评审 diff", skills: ["review"], activeRuns: 2 }),
      ],
      { verb: "review" },
    );
    // The reviewer is busier, but the verb signal outweighs idleness.
    expect(recall.hits[0]?.agentId).toBe("reviewer");
  });

  test("an idle worker wins among equals", () => {
    const recall = recallWorkers(
      [
        card({ id: "busy", description: "frontend", activeRuns: 1, lastRunAt: 5 }),
        card({ id: "idle", description: "frontend", activeRuns: 0, lastRunAt: 50 }),
      ],
      { verb: "build", objectKind: "code" },
    );
    expect(recall.hits.map((h) => h.agentId)).toEqual(["idle", "busy"]);
    expect(recall.hits[0]?.why).toContain("idle");
  });

  test("slot terms are evidence: the scope path points at a card", () => {
    const recall = recallWorkers(
      [
        card({ id: "web", description: "web 前端" }),
        card({ id: "api", description: "backend api" }),
      ],
      { verb: "fix", terms: ["src/web/settings", "src/web"] },
    );
    expect(recall.hits[0]?.agentId).toBe("web");
    expect(recall.hits[0]?.why.join(" ")).toContain("brief mentions");
  });

  test("fronts are excluded, and the manifest says why", () => {
    const recall = recallWorkers([card({ id: "lead", role: "front" }), card({ id: "w" })], {
      verb: "fix",
    });
    expect(recall.hits.map((h) => h.agentId)).toEqual(["w"]);
    expect(recall.excluded).toEqual([{ agentId: "lead", reason: "not a worker role" }]);
  });

  test("no card signal still yields a best-effort pick, ranked by load", () => {
    const recall = recallWorkers(
      [card({ id: "a", activeRuns: 2, lastRunAt: 9 }), card({ id: "b", activeRuns: 0 })],
      { verb: "operate" },
    );
    expect(recall.hits).toHaveLength(2);
    expect(recall.hits[0]?.agentId).toBe("b");
    // Nothing matched the verb: the reason must not pretend otherwise.
    expect(recall.hits[0]?.why.join(" ")).not.toContain("verb operate");
  });

  test("the reason handed to the model names the signals and the field size", () => {
    const recall = recallWorkers(
      [card({ id: "fe", description: "修前端 bug" }), card({ id: "be", description: "后端服务" })],
      { verb: "fix" },
    );
    const reason = describePick(recall.hits[0]!, recall);
    expect(reason).toContain("verb fix");
    expect(reason).toContain("chosen from 2");
  });
});
