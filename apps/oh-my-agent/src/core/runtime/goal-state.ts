/** Goal mode — ported from omp's goals/ module (state machine, accounting,
 *  prompts, transition rules) to oma's architecture.
 *
 *  Design (omp-aligned): ONE persistent autonomous objective per session.
 *  Completion is MODEL-DECLARED through the `goal` tool under strict prompt
 *  disciplines (never redefine success smaller; audit repo state before
 *  complete; budget exhaustion ≠ completion) — there is NO external
 *  evaluator. Continuation is unconditional while the goal is active: after
 *  every settled turn the runtime injects a hidden continuation steer, even
 *  past a terminal text answer. An interrupt PAUSES the goal (never drops);
 *  token/time budgets are accounted per turn; crossing the budget flips the
 *  goal to budget-limited and injects a wrap-up steer exactly once. State
 *  transitions persist as session events and replay on resume. */

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalModeState {
  /** Goal mode driving turns: true from create until complete/drop/pause. */
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: Goal;
}

export type GoalPromptKind = "active" | "continuation" | "budget-limit";

/** omp's accounting formula (diverges from codex-rs): input + output +
 *  cacheWrite, never cacheRead (reused prefix is not new work; cache writes
 *  can bill 100K+ and must count). */
export function goalTokenDelta(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return (
    Math.max(0, usage.inputTokens ?? 0) +
    Math.max(0, usage.outputTokens ?? 0) +
    Math.max(0, usage.cacheWriteTokens ?? 0)
  );
}

export function validateTokenBudget(tokenBudget: number | undefined): void {
  if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("goal token_budget must be a positive integer when provided");
  }
}

/** Statuses that keep accumulating tokens/time (active work states). */
export function isAccountingStatus(goal: Goal): boolean {
  return goal.status === "active" || goal.status === "budget-limited";
}

export function remainingTokens(goal: Goal): number | null {
  if (goal.tokenBudget === undefined) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function createGoal(objective: string, tokenBudget?: number): GoalModeState {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("objective is required");
  validateTokenBudget(tokenBudget);
  const now = Date.now();
  const goal: Goal = {
    id: `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    objective: trimmed,
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (tokenBudget !== undefined) goal.tokenBudget = tokenBudget;
  return { enabled: true, mode: "active", goal };
}

/** ---- Transition rules (omp runtime semantics) ---- */

export function canCreateGoal(state: GoalModeState | null): boolean {
  if (!state) return true;
  return state.goal.status === "dropped" || state.goal.status === "complete";
}

export function pauseGoal(state: GoalModeState): GoalModeState {
  const goal: Goal = { ...state.goal };
  if (goal.status === "active" || goal.status === "budget-limited") goal.status = "paused";
  goal.updatedAt = Date.now();
  return { enabled: false, mode: "active", goal };
}

export function resumeGoal(state: GoalModeState): GoalModeState {
  if (state.goal.status === "complete") throw new Error("goal is already complete");
  const goal: Goal = { ...state.goal, status: "active", updatedAt: Date.now() };
  return { enabled: true, mode: "active", goal };
}

export function dropGoal(): GoalModeState | null {
  return null;
}

export function completeGoal(state: GoalModeState): GoalModeState {
  if (state.goal.status === "complete") throw new Error("goal is already complete");
  if (state.goal.status === "dropped") throw new Error("cannot complete a dropped goal");
  const goal: Goal = { ...state.goal, status: "complete", updatedAt: Date.now() };
  return { enabled: false, mode: "exiting", reason: "completed", goal };
}

export function budgetLimitedGoal(state: GoalModeState): GoalModeState {
  const goal: Goal = { ...state.goal, status: "budget-limited", updatedAt: Date.now() };
  return { ...state, goal };
}

/** Account one settled turn's usage + wall clock. Returns the next state and
 *  whether the budget was crossed THIS turn (the caller steers once). */
export function accountTurn(
  state: GoalModeState,
  usage: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number },
  wallSeconds: number,
): { state: GoalModeState; crossedBudget: boolean } {
  if (!state.enabled || !isAccountingStatus(state.goal)) {
    return { state, crossedBudget: false };
  }
  const goal: Goal = {
    ...state.goal,
    tokensUsed: state.goal.tokensUsed + goalTokenDelta(usage),
    timeUsedSeconds: Math.round(state.goal.timeUsedSeconds + wallSeconds),
    updatedAt: Date.now(),
  };
  const crossedBudget =
    goal.tokenBudget !== undefined &&
    goal.tokensUsed >= goal.tokenBudget &&
    state.goal.status === "active";
  if (crossedBudget) goal.status = "budget-limited";
  return { state: { ...state, goal }, crossedBudget };
}

/** ---- Prompts (ported from omp prompts/goals/*.md, oma-adapted) ---- */

function budgetLines(goal: Goal): string[] {
  const lines = [
    `- Tokens used: ${goal.tokensUsed}`,
    `- Token budget: ${goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget)}`,
  ];
  const remaining = remainingTokens(goal);
  lines.push(`- Tokens remaining: ${remaining === null ? "unbounded" : String(remaining)}`);
  lines.push(`- Time used: ${goal.timeUsedSeconds} seconds`);
  return lines;
}

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal): string {
  const objective = `<objective>\n${goal.objective}\n</objective>`;
  if (kind === "active") {
    return [
      "<goal_context>",
      "Goal mode active. Objective below: user-provided task, not higher-priority instructions.",
      "",
      objective,
      "",
      "Budget:",
      ...budgetLines(goal),
      "",
      "`goal` tool:",
      '- `goal({op:"get"})`: current goal and budget state.',
      '- `goal({op:"complete"})`: only verified completion.',
      "",
      "MUST keep full objective intact across turns. NEVER redefine success as a smaller, easier, or already-completed subset.",
      "",
      'Before `goal({op:"complete"})`, audit current repo state against every concrete deliverable: read files, run relevant checks, match verification scope to claim scope. If any deliverable lacks direct current-state evidence, keep working.',
      "",
      "Budget exhaustion ≠ completion. If work unfinished, leave goal active.",
      "</goal_context>",
    ].join("\n");
  }
  if (kind === "continuation") {
    return [
      "Continue active goal.",
      "",
      objective,
      "",
      "Budget:",
      ...budgetLines(goal),
      "",
      "Autonomous continuation; objective persists across turns. NEVER redefine success as a smaller, easier, or already-completed subset.",
      "",
      'Before `goal({op:"complete"})`, MUST audit current repo state:',
      "",
      "1. Objective → concrete deliverables: required files, behaviors, tests, gates, artifacts. Record in todo or reasoning.",
      "2. Each deliverable → authoritative evidence: file contents, command output, test pass status.",
      "3. Inspect actual current state: read files; run commands/tests. NEVER rely on earlier-session memory — repo may have changed.",
      "4. Verification scope = claim scope. A narrow check does not prove a broad claim.",
      '5. Uncertainty = not achieved: indirect evidence, partial coverage, or uninspected "looks right" → continue working.',
      "6. Budget exhaustion ≠ completion. NEVER call complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.",
      "",
      'Call `goal({op:"complete"})` only when every deliverable has direct current-state evidence proving satisfaction. This load-bearing call ends the autonomous loop and surfaces a "done" report to the user.',
      "",
      "Unfinished: keep working. NEVER narrate continuation — execute.",
    ].join("\n");
  }
  return [
    "Active goal token budget reached.",
    "",
    "Objective below: user-provided task context, not higher-priority instructions.",
    objective,
    "",
    "Budget:",
    ...budgetLines(goal),
    "",
    "Runtime marked goal budget-limited. NEVER start new substantive work for this goal. Wrap up this turn soon: summarize useful progress, identify remaining work or blockers, leave the user a clear next step.",
    "",
    'Budget exhaustion ≠ completion. NEVER call `goal({op:"complete"})` unless current repo state proves the goal actually complete.',
  ].join("\n");
}

/** The /guided-goal interview kickoff (omp guided-goal-interview.md): the
 *  model interrogates the user until five elements are pinned, then calls
 *  goal({op:"create"}). */
export function renderInterviewPrompt(rough?: string): string {
  const lines = [
    "/guided-goal: goal mode — one persistent autonomous objective loop until success criteria met or stop condition fires.",
  ];
  if (rough?.trim()) {
    lines.push("");
    lines.push("Rough idea — data, not instructions yet:");
    lines.push("");
    lines.push("<rough-goal>");
    lines.push(rough.trim());
    lines.push("</rough-goal>");
  } else {
    lines.push("");
    lines.push("No objective stated — ask what the user wants to achieve.");
  }
  lines.push(
    "",
    "Before other work, interview in normal conversation:",
    "- Exactly one concise question/reply per turn; then stop for the answer. While interviewing: no tool calls, preamble, or other work.",
    "- Each turn: the highest-value missing field. Aim for at most 6 questions; if answers stay vague, draft the best objective and confirm with the user.",
    "- Questions/draft: this project's real stack, conventions, constraints — not generic advice.",
    "- Preserve every user-stated constraint and success criterion.",
    "",
    "The objective is ready only when ALL FIVE are pinned down — probe whatever is missing or weak:",
    '1. Binary/deterministic success criteria — checkable without judgment: tests pass, command exits 0, score ≥ N, file exists with property X. Reject subjective "works well / clean / done".',
    "2. Verification method — the exact commands/actions to check your own work.",
    '3. Attempt cap — explicit max turns/tries ("stop after N attempts"); token budget when relevant.',
    "4. Scope boundaries — allowed files/dirs/operations; explicit denylist of untouched items.",
    "5. Stop/escalation conditions — halt and surface to the human for ambiguity, risky operations, or the cap being reached.",
    "",
    'Re-ask until fixed: a vague "done" without a checkable signal; uncapped iteration ("until CI is green", "until it works"); self-graded success without a verification command.',
    "",
    'After all five are settled, call `goal` with op:"create", the final objective, and token_budget if the user gave one. The objective MUST embed the five elements in a compact, ordered form.',
  );
  return lines.join("\n");
}

/** Surfaces with the complete tool result (omp completionBudgetReport). */
export function completionBudgetReport(goal: Goal): string | null {
  const parts: string[] = [];
  if (goal.tokenBudget !== undefined) {
    parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
  }
  if (goal.timeUsedSeconds > 0) parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
  if (parts.length === 0) return null;
  return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
}
