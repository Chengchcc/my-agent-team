import { describe, expect, test } from "bun:test";
import type { AgentRow } from "@/lib/api";
import { resolveDefaultPa, resolveRecommendedSkill } from "./PaSession";

function agent(overrides: Partial<AgentRow>): AgentRow {
  return {
    id: "a1",
    name: "Agent",
    role: "front",
    harness: "oma",
    enabled: true,
    archivedAt: null,
    ...overrides,
  } as AgentRow;
}

describe("resolveDefaultPa", () => {
  test("prefers enabled non-archived default PA over workers and other PAs", () => {
    const list = [
      agent({ id: "worker-1", role: "worker", name: "Coder" }),
      agent({ id: "pa-2", role: "front", name: "Second PA" }),
      agent({ id: "default", role: "front", name: "Main PA" }),
    ];
    expect(resolveDefaultPa(list)?.id).toBe("default");
  });

  test("skips disabled and archived PAs when an active PA exists", () => {
    const list = [
      agent({ id: "default", enabled: false }),
      agent({ id: "archived", archivedAt: 1000 }),
      agent({ id: "active-pa", name: "Active PA" }),
    ];
    expect(resolveDefaultPa(list)?.id).toBe("active-pa");
  });

  test("returns undefined when only workers exist", () => {
    expect(resolveDefaultPa([agent({ id: "coder", role: "worker" })])).toBeUndefined();
  });
});

describe("resolveRecommendedSkill", () => {
  const spec = {
    fallbackCommand: "/member_manage",
    matchKeyword: "member",
    fallbackDescription: "Manage members",
    contextLine: "Member: Coder (coder)",
  };

  test("resolves installed skill command and marks it available", () => {
    const out = resolveRecommendedSkill(
      [{ command: "/member_manage", description: "Create or edit team members" }],
      true,
      spec,
    );
    expect(out).toEqual({
      command: "/member_manage",
      description: "Manage members",
      available: true,
      contextLine: "Member: Coder (coder)",
    });
  });

  test("marks skill unavailable once loaded if the PA does not have it", () => {
    const out = resolveRecommendedSkill(
      [{ command: "/workflow_design", description: "Workflows" }],
      true,
      spec,
    );
    expect(out?.available).toBe(false);
    expect(out?.command).toBe("/member_manage");
  });

  test("stays optimistic while skills are still loading", () => {
    const out = resolveRecommendedSkill([], false, spec);
    expect(out?.available).toBe(true);
  });
});
