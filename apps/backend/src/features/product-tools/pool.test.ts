import { describe, expect, test } from "bun:test";
import { type PoolCandidate, pickFromPool } from "./pool.js";

function card(over: Partial<PoolCandidate> & { id: string }): PoolCandidate {
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

describe("ADR 0052 pooled dispatch", () => {
  test("idle beats busy even when busy has better skills", () => {
    const pick = pickFromPool([
      card({ id: "busy", skills: ["react"], activeRuns: 2, lastRunAt: 5 }),
      card({ id: "idle", activeRuns: 0, lastRunAt: 50 }),
    ]);
    expect(pick?.agentId).toBe("idle");
    expect(pick?.reason).toContain("idle");
  });

  test("same load → least recently started wins (spreads work)", () => {
    const pick = pickFromPool([
      card({ id: "recent", lastRunAt: 100 }),
      card({ id: "stale", lastRunAt: 10 }),
    ]);
    expect(pick?.agentId).toBe("stale");
  });

  test("full tie → stable id order, so repeated calls do not flap", () => {
    expect(pickFromPool([card({ id: "b" }), card({ id: "a" })])?.agentId).toBe("a");
  });

  test("capability narrows by skill and by description", () => {
    const pool = [
      card({ id: "fe", skills: ["react", "css"] }),
      card({ id: "be", skills: ["api"], description: "backend services" }),
    ];
    expect(pickFromPool(pool, "React")?.agentId).toBe("fe");
    expect(pickFromPool(pool, "backend")?.agentId).toBe("be");
  });

  test("a capability nobody claims yields no pick (the caller reports the roster)", () => {
    expect(pickFromPool([card({ id: "fe", skills: ["react"] })], "kubernetes")).toBeNull();
  });

  test("fronts are not in the pool", () => {
    expect(pickFromPool([card({ id: "lead", role: "front" })])).toBeNull();
  });

  test("a worker with role null (legacy row) is not in the pool either", () => {
    expect(pickFromPool([card({ id: "legacy", role: null })])).toBeNull();
  });
});
