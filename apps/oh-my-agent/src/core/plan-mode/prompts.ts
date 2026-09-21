import type { PlanModeState } from "./state.js";

/** Plan-mode prompt blocks.
 *
 *  Read-only is enforced by the FILE TOOL GUARD (write/edit refuse anything
 *  outside the plan draft — see core/tools/file-tools.ts), not by an allowlist:
 *  investigation needs the full read surface plus bash. Bash is the honest
 *  exception and is prompt-guarded only, exactly like the reference
 *  implementation: a shell command can still change the tree, so the rule it
 *  states is the rule that holds. */

export function planModePrompt(state: PlanModeState): string {
  return [
    "<plan_mode>",
    "Plan mode is active: investigate and produce a PLAN. The working tree is read-only for you.",
    "",
    `Write the plan to: ${state.planPath}`,
    "(the only path write/edit will accept while plan mode is on)",
    "",
    "Rules:",
    "- Do NOT modify the project. read/grep/glob/ls/tree and bash for INSPECTION only",
    "  (git status, reading logs, running tests to learn the current state).",
    "- Do NOT create, edit, move, or delete project files; do not run commands that",
    "  mutate state (installs, apply, commit, rm, writes).",
    "- Investigate before you draft: read the files the change touches, and check",
    "  the assumptions the design depends on. An assumption you did not verify is",
    "  a liability — name it in the plan instead of silently relying on it.",
    "",
    "The plan is a Markdown document. Cover, in this order:",
    "1. **Context** — what changes and why, in the user's terms.",
    "2. **Approach** — the design, including the alternatives you rejected and why.",
    "3. **Critical files** — every file to touch, with the change each one gets.",
    "4. **Verification** — the exact commands that prove the change works.",
    "5. **Assumptions** — what you verified, and what remains a guess.",
    "",
    "Prefer explicit steps with an order that can actually be executed; call out",
    "anything that has to happen before something else, and any rollback path.",
    "When the plan is ready, write it to the path above and say so in one line.",
    "</plan_mode>",
  ].join("\n");
}

/** Sent when a planning turn settled without a draft: the model answered as if
 *  in a normal turn, so the mode's contract has to be restated once. Capped by
 *  the caller — a reminder loop would be worse than a missing plan. */
export function planReminderPrompt(state: PlanModeState): string {
  return [
    "<plan_mode_reminder>",
    "Plan mode is still active, but no plan was written this turn.",
    "",
    `Write the plan (Markdown, the five sections below) to ${state.planPath} using write,`,
    "then stop. Do not implement anything.",
    "",
    "Sections: Context / Approach / Critical files / Verification / Assumptions.",
    "If you are still missing information, say what you need in one line instead of",
    "guessing — the user can answer and you continue planning.",
    "</plan_mode_reminder>",
  ].join("\n");
}

/** Refinement: a review follow-up goes back to the planning turn as plain
 *  user text, with the draft path restated so the model edits THAT document. */
export function planRefinePrompt(state: PlanModeState, feedback: string): string {
  return [
    "<plan_mode_refine>",
    `Revise the plan at ${state.planPath}.`,
    "",
    "Feedback on the current draft:",
    feedback.trim(),
    "",
    "Keep everything the feedback does not ask you to change, and write the whole",
    "revised document back to the same path. Do not implement anything yet.",
    "</plan_mode_refine>",
  ].join("\n");
}
