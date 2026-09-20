import type { AIMessageChunk, Message } from "@chengchenccc/message";

/** Goal mode (CC /goal shape): a session-scoped completion condition plus an
 *  independent evaluator that judges, after every Run, whether the condition
 *  holds — so the loop keeps working without a per-turn human prompt. The
 *  evaluator NEVER runs commands or reads files: it judges only what the
 *  agent surfaced in the transcript (write the condition so the work can
 *  demonstrate it), and its NOT_YET reason becomes the next turn's guidance.
 *
 *  Orthogonal to permission modes: auto/yolo govern per-TOOL freedom, the
 *  goal governs per-TURN continuation. Unattended = goal + auto/yolo. */

export interface GoalVerdict {
  readonly verdict: "met" | "not_yet" | "impossible";
  readonly reason?: string;
}

/** Evaluation result: a verdict, or an evaluator failure. A failure must NOT
 *  read as "not yet" — that would spin the loop on a broken evaluator. */
export type GoalEvaluation = GoalVerdict | { readonly error: string };

export function isGoalError(evaluation: GoalEvaluation): evaluation is { readonly error: string } {
  return "error" in evaluation;
}

/** `OMA_GOAL_MODEL` (`provider/model`): the evaluator model. Absent = the
 *  session's model. CC pins a small fast model here; deployments can too. */
export function goalEvaluatorModelId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env.OMA_GOAL_MODEL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export const DEFAULT_GOAL_MAX_TURNS = 40;

/** `OMA_GOAL_MAX_TURNS`: hard cap on goal-driven auto-continuation turns
 *  (the loop-level analogue of maxSteps; the condition text can always add
 *  a tighter clause). */
export function goalMaxTurns(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.OMA_GOAL_MAX_TURNS;
  const n = raw === undefined ? DEFAULT_GOAL_MAX_TURNS : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_GOAL_MAX_TURNS;
}

export const DEFAULT_GOAL_EVALUATION_TIMEOUT_MS = 30_000;

/** Anti-injection discipline (same as the permission classifier): the
 *  evaluator sees the condition and the TRANSCRIPT EVIDENCE the caller
 *  chose to surface. Tool results are quoted as evidence — that is the
 *  point (tests passing) — but the evaluator only ever returns a verdict,
 *  never executes anything, so hostile content can at worst lie about
 *  progress, not act. */
export function buildGoalMessages(condition: string, evidence: readonly string[]): Message[] {
  const system =
    "You are the goal evaluator for an AI coding agent. After each of the agent's turns you " +
    "judge whether the user's completion condition holds, using ONLY the transcript evidence " +
    "provided — you cannot run commands or read files.\n" +
    "Respond with ONLY a JSON object:\n" +
    '{"verdict":"met"} — the condition demonstrably holds now;\n' +
    '{"verdict":"not_yet","reason":"<short, actionable guidance for the next turn>"} — clear ' +
    "progress remains (be specific about what is left);\n" +
    '{"verdict":"impossible","reason":"<why it can never be satisfied>"} — the condition cannot ' +
    "be met from what the evidence shows (missing access, contradictory constraints).\n" +
    "Prefer not_yet over impossible: impossible only when no further turn could help.";
  const user =
    `Completion condition:\n${condition}\n\n` +
    `Transcript evidence (oldest first, this turn last):\n${evidence
      .map((line) => `- ${line}`)
      .join("\n")}`;
  return [
    { role: "system", text: system },
    { role: "user", text: user },
  ];
}

/** Defensive verdict parse: fenced JSON tolerated; anything else is an
 *  ERROR (not a verdict) so the loop stops instead of spinning. */
export function parseGoalVerdict(text: string): GoalEvaluation {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { error: "evaluator returned no verdict" };
  }
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      verdict?: unknown;
      reason?: unknown;
    };
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 300)
        : undefined;
    if (parsed.verdict === "met") return { verdict: "met" };
    if (parsed.verdict === "not_yet") return { verdict: "not_yet", reason };
    if (parsed.verdict === "impossible") return { verdict: "impossible", reason };
    return { error: "evaluator returned an unknown verdict" };
  } catch {
    return { error: "evaluator returned no verdict" };
  }
}

export type GoalEvaluatorStream = (
  messages: readonly Message[],
  signal?: AbortSignal,
  modelIdOverride?: string,
) => AsyncIterable<AIMessageChunk>;

/** One evaluator call. NEVER throws: every failure path is { error }. */
export async function evaluateGoal(opts: {
  condition: string;
  evidence: readonly string[];
  stream: GoalEvaluatorStream;
  timeoutMs?: number;
  modelId?: string;
}): Promise<GoalEvaluation> {
  try {
    const messages = buildGoalMessages(opts.condition, opts.evidence);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GOAL_EVALUATION_TIMEOUT_MS;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let text = "";
    for await (const chunk of opts.stream(
      messages,
      signal,
      opts.modelId ?? goalEvaluatorModelId(),
    )) {
      if (chunk.delta?.type === "text") text += chunk.delta.text;
    }
    return parseGoalVerdict(text);
  } catch (err) {
    return {
      error: `goal evaluator unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface GoalCycleFacts {
  readonly verdict: GoalEvaluation;
  readonly turns: number;
  readonly maxTurns: number;
  /** Consecutive goal turns whose run used NO tools (progress detector). */
  readonly noProgressRuns: number;
  /** Whether the run that just settled used at least one tool. */
  readonly runHadTools: boolean;
  /** Terminal status of the run that just settled ("completed"/"failed"/…). */
  readonly runStatus: string;
  /** Background jobs still running (evaluation defers to their wake-up). */
  readonly runningBgJobs: number;
}

export type GoalCycleDecision =
  | { readonly action: "continue"; readonly guidance: string }
  | { readonly action: "wait"; readonly reason: string }
  | { readonly action: "stop"; readonly reason: string };

const NO_PROGRESS_LIMIT = 3;

/** Pure decision for the TUI loop: what to do after a settled Run when a
 *  goal is active. Extracted so every branch is unit-testable without a
 *  terminal. Order matters: terminal run states and evaluator errors stop
 *  first (fail-safe), background work defers, then the verdict and the
 *  caps decide. */
export function decideGoalCycle(facts: GoalCycleFacts): GoalCycleDecision {
  const runFailed = facts.runStatus === "failed" || facts.runStatus === "aborted";
  if (runFailed) {
    return {
      action: "stop",
      reason: `run ${facts.runStatus} — clear the goal (fix and /goal again)`,
    };
  }
  if (facts.runningBgJobs > 0) {
    return {
      action: "wait",
      reason: `${facts.runningBgJobs} background job(s) running — their settlement wakes the goal`,
    };
  }
  if (isGoalError(facts.verdict)) {
    return { action: "stop", reason: facts.verdict.error };
  }
  if (facts.verdict.verdict === "met") {
    return { action: "stop", reason: `goal met after ${facts.turns} turn(s)` };
  }
  if (facts.verdict.verdict === "impossible") {
    return {
      action: "stop",
      reason: `goal impossible: ${facts.verdict.reason ?? "no reason given"}`,
    };
  }
  if (facts.turns >= facts.maxTurns) {
    return { action: "stop", reason: `goal hit the turn cap (${facts.maxTurns})` };
  }
  const stalled = facts.noProgressRuns >= NO_PROGRESS_LIMIT;
  if (stalled) {
    return {
      action: "stop",
      reason: `no tool use for ${facts.noProgressRuns} goal turns — returning control`,
    };
  }
  return {
    action: "continue",
    guidance: facts.verdict.reason ?? "the condition is not yet met; keep working",
  };
}
