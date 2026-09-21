import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRuntime } from "./runtime.js";
import { writePlan } from "./state.js";

/** Plan mode's state machine, extracted from the TUI closure: the surface
 *  renders decisions, so every rule (pause semantics, the once-per-entry
 *  contract, the reminder budget, the model swap, the resume-as-paused rule)
 *  is pinned here rather than through a terminal. */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempWs(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-planrt-"));
  dirs.push(dir);
  return dir;
}

function rtWith(planModel?: string) {
  const persisted: Array<{ planPath: string | null; paused: boolean }> = [];
  const rt = new PlanRuntime(
    tempWs(),
    (state, paused) => persisted.push({ planPath: state?.planPath ?? null, paused }),
    planModel,
  );
  return { rt, persisted };
}

describe("PlanRuntime transitions", () => {
  test("off → enter → pause → leave, with every transition persisted", () => {
    const { rt, persisted } = rtWith();
    expect(rt.state).toBeNull();
    expect(rt.enabled).toBe(false);

    rt.enter("s1");
    expect(rt.state?.enabled).toBe(true);
    expect(rt.enabled).toBe(true);
    expect(persisted).toHaveLength(1);

    rt.pause();
    expect(rt.paused).toBe(true);
    // Paused is NOT enabled: no turn is driven, but the draft and the mode stay.
    expect(rt.enabled).toBe(false);
    expect(rt.state).not.toBeNull();
    expect(persisted.at(-1)).toEqual({ planPath: rt.draftPath ?? null, paused: true });

    rt.leave();
    expect(rt.state).toBeNull();
    expect(rt.paused).toBe(false);
    expect(persisted.at(-1)).toEqual({ planPath: null, paused: false });
  });

  test("re-entry keeps the draft and does NOT re-arm the contract", () => {
    const { rt } = rtWith();
    rt.enter("s1");
    expect(rt.takeContractPrompt(() => "CONTRACT")).toBe("CONTRACT");
    expect(rt.takeContractPrompt(() => "CONTRACT")).toBeNull(); // once per entry

    rt.pause();
    rt.enter("s1", true); // /plan <follow-up>
    expect(rt.takeContractPrompt(() => "CONTRACT")).toBeNull(); // still delivered
    rt.leave();
    rt.enter("s1"); // a fresh entry re-arms it
    expect(rt.takeContractPrompt(() => "CONTRACT")).toBe("CONTRACT");
  });

  test("restore brings a planning session back PAUSED, never driving turns", () => {
    const { rt } = rtWith();
    rt.restore({ planPath: "/ws/.oma/plans/x.md" }, "s1");
    expect(rt.paused).toBe(true);
    expect(rt.enabled).toBe(false);
    expect(rt.state?.planPath).toBe("/ws/.oma/plans/x.md");
    // A missing path falls back to this session's own draft path.
    rt.restore({ planPath: "" }, "s2");
    expect(rt.state?.planPath).toContain("s2");
  });

  test("the write guard exists only while planning is live", () => {
    const { rt } = rtWith();
    expect(rt.writeGuard).toBeUndefined();
    rt.enter("s1");
    expect(rt.writeGuard?.planPath).toBe(rt.draftPath);
    rt.pause();
    expect(rt.writeGuard).toBeUndefined(); // a paused mode must not gate writes
  });

  test("the model swap: plan model while planning, the prior model after", () => {
    const { rt } = rtWith("provider/planner");
    rt.notePriorModel("provider/implementer");
    rt.enter("s1");
    expect(rt.activeModel).toBe("provider/planner");
    rt.leave();
    expect(rt.activeModel).toBe("provider/implementer");
    // Without a configured plan model the session keeps its own.
    const bare = rtWith();
    bare.rt.notePriorModel("provider/only");
    bare.rt.enter("s1");
    expect(bare.rt.activeModel).toBe("provider/only");
  });

  test("refine re-arms planning on the same draft", () => {
    const { rt } = rtWith();
    rt.enter("s1");
    rt.pause();
    expect(rt.paused).toBe(true);
    rt.refine("s1");
    expect(rt.paused).toBe(false);
    expect(rt.enabled).toBe(true);
  });
});

describe("PlanRuntime settle decisions", () => {
  // Must clear planIsSubstantial: >= 120 chars and at least two headings.
  const substantial = [
    "# Plan",
    "",
    "## Approach",
    "",
    "- do the thing carefully, in the order the plan states,",
    "- verify with the exact commands listed below,",
    "",
    "## Verification",
    "",
    "run the focused suite and the typecheck",
  ].join("\n");

  test("no draft → one reminder, then stalled (never a reminder loop)", () => {
    const { rt } = rtWith();
    rt.enter("s1");
    expect(rt.settleTurn()).toEqual({ action: "remind" });
    expect(rt.settleTurn()).toEqual({ action: "stalled" });
    // A user turn resets the budget: they just spoke.
    rt.onUserTurn();
    expect(rt.settleTurn()).toEqual({ action: "remind" });
  });

  test("a substantial draft reports its title and stops reminding", () => {
    const { rt } = rtWith();
    rt.enter("s1");
    expect(rt.settleTurn()).toEqual({ action: "remind" }); // nothing on disk yet
    // The model writes the plan to the draft path.
    writePlan(rt.draftPath!, substantial);
    expect(rt.settleTurn()).toEqual({ action: "idle", draftTitle: "Plan" });
    expect(rt.hasDraft()).toBe(true);
    expect(rt.draftTitle()).toBe("Plan");
  });

  test("a paused or absent mode decides nothing", () => {
    const { rt } = rtWith();
    expect(rt.settleTurn()).toEqual({ action: "idle" });
    rt.enter("s1");
    rt.pause();
    expect(rt.settleTurn()).toEqual({ action: "idle" });
  });

  test("saveCopy copies the draft out and reports failure when there is none", () => {
    const { rt } = rtWith();
    expect(rt.saveCopy("/tmp/never.md")).toBe(false);
    rt.enter("s1");
    writePlan(rt.draftPath!, substantial);
    const dest = join(tempWs(), "saved.md");
    expect(rt.saveCopy(dest)).toBe(true);
  });
});
