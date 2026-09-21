import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planModePrompt, planRefinePrompt, planReminderPrompt } from "./prompts.js";
import {
  enterPlanMode,
  implementationTurn,
  newestPlan,
  planIsSubstantial,
  planPathFor,
  planTitle,
  readPlan,
  writePlan,
} from "./state.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-plan-state-"));
  dirs.push(dir);
  return dir;
}

describe("plan artifact (file, not message)", () => {
  test("the path is per session, so a review always names the draft it read", () => {
    const ws = tempWorkspace();
    expect(planPathFor(ws, "s1")).not.toBe(planPathFor(ws, "s2"));
    expect(planPathFor(ws, "s1")).toContain(join(".oma", "plans"));
  });

  test("write → read round-trips and creates the directory", () => {
    const ws = tempWorkspace();
    const path = planPathFor(ws, "s1");
    expect(readPlan(path)).toBeNull();
    writePlan(path, "# Plan\n\nbody\n");
    expect(readPlan(path)).toBe("# Plan\n\nbody\n");
  });

  test("newestPlan picks the latest draft and tolerates a missing dir", () => {
    const ws = tempWorkspace();
    expect(newestPlan(ws)).toBeNull(); // nothing written yet
    const older = planPathFor(ws, "older");
    writePlan(older, "# Older\n");
    const newer = planPathFor(ws, "newer");
    writePlan(newer, "# Newer\n");
    // Ordering is by MTIME, not by name — and two writes inside one
    // filesystem timestamp tick are indistinguishable, so the mtimes are set
    // explicitly instead of relying on wall-clock granularity.
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    expect(newestPlan(ws)).toBe(newer);
  });

  test("a title comes from the first heading, stripped of styling", () => {
    expect(planTitle("# **Migrate** the importer")).toBe("Migrate the importer");
    expect(planTitle("no heading here")).toBeUndefined();
    expect(planTitle(`# ${"x".repeat(200)}`)?.length).toBe(80);
  });

  test("substantiality: a stub is not a plan (a long text with no structure is not either)", () => {
    expect(planIsSubstantial("# One\n\nshort")).toBe(false);
    expect(planIsSubstantial(`# A\n${"x".repeat(200)}`)).toBe(false); // one heading
    expect(planIsSubstantial(`# A\n\n${"x".repeat(200)}\n\n## B\nmore`)).toBe(true);
  });

  test("entering marks a re-entry, so a resumed session cannot re-arm the mode", () => {
    expect(enterPlanMode("/p/a.md").reentry).toBeUndefined();
    expect(enterPlanMode("/p/a.md", true).reentry).toBe(true);
  });
});

describe("the implementation turn", () => {
  test("carries the plan, its durable path, and the contradiction rule", () => {
    const turn = implementationTurn("/ws/.oma/plans/s.md", "# Plan\n\nstep 1", false);
    expect(turn).toContain("APPROVED");
    expect(turn).toContain("<approved_plan>");
    expect(turn).toContain("step 1");
    expect(turn).toContain("/ws/.oma/plans/s.md");
    // A repository that contradicts the plan is reported, never improvised over.
    expect(turn).toContain("contradicts the plan");
    expect(turn).toContain("Work from the plan document alone");
  });

  test("keeping context says so explicitly instead of leaving it implicit", () => {
    const kept = implementationTurn("/p", "body", true);
    expect(kept).toContain("still in context");
    expect(kept).not.toContain("plan document alone");
  });
});

describe("plan-mode prompts state the rules the tool guard cannot enforce", () => {
  const state = enterPlanMode("/ws/.oma/plans/s.md");

  test("the contract names the one writable path, the read-only rule and the sections", () => {
    const text = planModePrompt(state);
    expect(text).toContain("/ws/.oma/plans/s.md");
    expect(text).toContain("read-only");
    // The five sections the review expects to find.
    for (const section of [
      "Context",
      "Approach",
      "Critical files",
      "Verification",
      "Assumptions",
    ]) {
      expect(text).toContain(section);
    }
    // Mutation is forbidden explicitly (bash has no code gate).
    expect(text).toContain("Do NOT modify the project");
    expect(text).toContain("read/grep/glob");
  });

  test("the reminder restates the contract in one short block, not the whole prompt", () => {
    const text = planReminderPrompt(state);
    expect(text).toContain("still active");
    expect(text).toContain("/ws/.oma/plans/s.md");
    expect(text.length).toBeLessThan(planModePrompt(state).length);
  });

  test("refine quotes the feedback and pins the same path", () => {
    const text = planRefinePrompt(state, "keep the schema, revise the rollout");
    expect(text).toContain("keep the schema, revise the rollout");
    expect(text).toContain("/ws/.oma/plans/s.md");
    expect(text).toContain("Do not implement anything yet");
  });
});
