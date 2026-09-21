import type { TodoItem } from "../tools/todo-store.js";
import {
  accountTurn,
  accrueUsage,
  completeGoal,
  completionBudgetReport,
  createGoal,
  type Goal,
  type GoalModeState,
  isAccountingStatus,
  pauseGoal,
  renderGoalPrompt,
  resumeGoal,
} from "./state.js";

/** The session-level goal runtime (omp's GoalRuntime analogue): the SINGLE
 *  owner of goal state, token/time accounting, and loop decisions. The TUI
 *  is presentation only — it forwards settled turns here and renders the
 *  decision; the `goal` tool mutates through the same object.
 *
 *  Why a class and not loose functions: accounting is stateful (the
 *  in-flight turn's usage must flush BEFORE a terminal transition, or the
 *  completion report misses the final turn — omp flushes inside
 *  completeGoalFromTool), and the loop needs one choke point to decide
 *  continue / wrap-up / pause. */

export interface GoalTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
}

export interface SettledTurn {
  usage: GoalTurnUsage;
  wallSeconds: number;
  status: "completed" | "failed" | "aborted" | "timeout";
  /** Whether the turn used any tool (stall backstop input). */
  usedTools: boolean;
}

export type GoalLoopDecision =
  | { action: "continue"; prompt: string; tokensUsed: number; tokenBudget?: number }
  | { action: "budget-wrapup"; prompt: string; tokensUsed: number; tokenBudget: number }
  | { action: "paused"; reason: string }
  | { action: "completed"; objective: string; report: string | null }
  | { action: "idle" };

const NO_PROGRESS_LIMIT = 3;

export class GoalRuntime {
  #state: GoalModeState | null = null;
  #noProgressTurns = 0;
  #interviewing = false;
  /** Set by complete(): the settled run's usage still has to land on the
   *  completed goal (the tool fired mid-run, before usage existed). */
  #pendingFinalFlush = false;

  constructor(
    /** Persist a transition (session event). Called on EVERY mutation so a
     *  quit right after /goal pause still survives resume. */
    /** Persist a transition. `recordCompletion` is false for the transition
     *  that still owes a usage flush (see complete()). */
    private readonly persist: (
      state: GoalModeState | null,
      recordCompletion: boolean,
    ) => void = () => {},
    /** Surface a transition for the UI (status line). */
    private readonly notify: (message: string) => void = () => {},
  ) {}

  get state(): GoalModeState | null {
    return this.#state;
  }

  get goal(): Goal | null {
    return this.#state?.goal ?? null;
  }

  get interviewing(): boolean {
    return this.#interviewing;
  }

  /** Whether the goal tool should be mounted for the next run. */
  get toolWanted(): boolean {
    return this.#interviewing || this.#state?.enabled === true;
  }

  beginInterview(): void {
    this.#interviewing = true;
  }

  /** Resume replay (session event): a live goal comes back PAUSED. */
  restore(state: GoalModeState | null): void {
    this.#state = state;
  }

  #commit(next: GoalModeState | null, options?: { recordCompletion?: boolean }): void {
    this.#state = next;
    this.persist(next, options?.recordCompletion !== false);
  }

  /** Start a goal, or REPLACE the current one (fresh counters and budget).
   *  A PAUSED goal cannot be silently overwritten: resume it and use set, or
   *  drop it first — otherwise parked work would vanish without a word. */
  create(objective: string, tokenBudget?: number): GoalModeState {
    if (this.#state?.goal.status === "paused") {
      throw new Error(
        "goal is paused — /goal resume then /goal set to replace it, or /goal drop first",
      );
    }
    const replacing = this.#state !== null;
    const next = createGoal(objective, tokenBudget);
    this.#interviewing = false;
    this.#noProgressTurns = 0;
    this.#commit(next);
    this.notify(
      replacing
        ? "goal replaced — new objective active; model declares completion"
        : "goal set — model declares completion via the goal tool; interrupt pauses",
    );
    return next;
  }

  pause(): void {
    if (!this.#state) return;
    this.#commit(pauseGoal(this.#state));
    this.notify("goal paused — /goal resume continues it");
  }

  resume(): void {
    if (!this.#state) return;
    this.#commit(resumeGoal(this.#state));
    this.#noProgressTurns = 0;
    this.notify("goal resumed — continuing on the next turn");
  }

  drop(): Goal | null {
    const dropped = this.#state?.goal ?? null;
    if (!this.#state) return null;
    this.#interviewing = false;
    this.#commit(null);
    if (dropped) this.notify(`goal dropped — ${dropped.objective}`);
    return dropped;
  }

  /** Set the TOTAL token budget (not an increment); accumulated usage is
   *  kept. Raising it past tokensUsed resumes a budget-limited goal; lowering
   *  it below re-limits. Returns a continuation prompt when the goal resumed,
   *  else null.
   *
   *  A PAUSED goal must be resumed first: changing the budget of work that is
   *  not running silently rewrites the terms of a decision the user already
   *  parked. */
  setBudget(budget: number | undefined): { prompt: string } | null {
    const state = this.#state;
    if (!state) return null;
    if (state.goal.status === "paused") {
      throw new Error("goal is paused — /goal resume before changing its budget");
    }
    if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0)) {
      throw new Error("budget must be a positive integer");
    }
    const goal: Goal = { ...state.goal, tokenBudget: budget, updatedAt: Date.now() };
    if (budget !== undefined && goal.tokensUsed >= budget) {
      goal.status = "budget-limited";
      this.#commit({ ...state, goal });
      this.notify(`goal budget-limited (${goal.tokensUsed} ≥ ${budget})`);
      return null;
    }
    if (state.goal.status === "budget-limited") {
      goal.status = "active";
      this.#commit({ ...state, enabled: true, goal });
      this.notify(`goal budget raised to ${budget ?? "unbounded"} — resumed`);
      return { prompt: renderGoalPrompt("continuation", goal) };
    }
    this.#commit({ ...state, goal });
    this.notify(`goal budget set to ${budget ?? "unbounded"}`);
    return null;
  }

  /** Flush the in-flight turn into the goal, then mark it complete. The
   *  turn's provider usage is only known when the run SETTLES, so the final
   *  flush is deferred there (#pendingFinalFlush) — the report the settle
   *  returns covers the final turn, exactly like omp's flush-inside-
   *  completeGoalFromTool. */
  complete(): void {
    const state = this.#state;
    if (!state) throw new Error("no goal to complete");
    // The turn's usage is only known at settle, so the transition is committed
    // WITHOUT the completion record; settleTurn flushes usage and commits
    // again, and only THAT commit carries the final numbers (a record written
    // here would state zero usage and the flush would write a second one).
    this.#pendingFinalFlush = isAccountingStatus(state.goal);
    const done = completeGoal(state);
    this.#commit(done, { recordCompletion: false });
    this.notify(`goal COMPLETE — ${done.goal.objective}`);
  }

  /** The status-bar indicator: the state plus the usage the user supervises
   *  the goal with. The driver owns its wording. */
  statusLabel(): string | undefined {
    const goal = this.#state?.goal;
    if (!goal) return undefined;
    const used = `${goal.tokensUsed} tok`;
    const usage = goal.tokenBudget !== undefined ? `${used}/${goal.tokenBudget}` : used;
    return `◎ goal ${goal.status} ${usage}`;
  }

  remainingTokens(): number | null {
    const goal = this.#state?.goal;
    if (!goal || goal.tokenBudget === undefined) return null;
    return Math.max(0, goal.tokenBudget - goal.tokensUsed);
  }

  /** The loop's post-turn decision. Fail-safe ordering: an interrupted or
   *  failed turn PAUSES and never queues work (omp onTaskAborted flushes
   *  with steering suppressed); a terminal transition reports; budget
   *  crossing wraps up once; otherwise continue (or pause on a stall). */
  settleTurn(turn: SettledTurn): GoalLoopDecision {
    const state = this.#state;
    if (!state) return { action: "idle" };
    // A complete/drop fired mid-run: fold the settled turn into the goal
    // first so the report (and the persisted numbers) include it.
    if (this.#pendingFinalFlush) {
      this.#pendingFinalFlush = false;
      const current = this.#state ?? state;
      // accrueUsage, not accountTurn: the goal is already terminal, but the
      // final turn's tokens still belong to it.
      this.#commit({
        ...current,
        goal: accrueUsage(current.goal, turn.usage, turn.wallSeconds),
      });
    }
    if (!isAccountingStatus(state.goal)) {
      if (state.reason === "completed") {
        return {
          action: "completed",
          objective: state.goal.objective,
          report: completionBudgetReport(this.#state?.goal ?? state.goal),
        };
      }
      return { action: "idle" };
    }
    const accounted = accountTurn(state, turn.usage, turn.wallSeconds);
    const current = accounted.state.goal;
    if (turn.status !== "completed") {
      this.#commit(pauseGoal(accounted.state));
      const reason = `run ${turn.status} — goal paused; /goal resume continues`;
      this.notify(reason);
      return { action: "paused", reason };
    }
    if (accounted.crossedBudget) {
      this.#commit(accounted.state);
      return {
        action: "budget-wrapup",
        prompt: renderGoalPrompt("budget-limit", current),
        tokensUsed: current.tokensUsed,
        tokenBudget: current.tokenBudget ?? 0,
      };
    }
    if (current.status !== "active") {
      this.#commit(accounted.state);
      return { action: "idle" };
    }
    this.#noProgressTurns = turn.usedTools ? 0 : this.#noProgressTurns + 1;
    if (this.#noProgressTurns >= NO_PROGRESS_LIMIT) {
      this.#commit(pauseGoal(accounted.state));
      const reason = `${this.#noProgressTurns} goal turns without tool use — paused; /goal resume continues`;
      this.notify(reason);
      return { action: "paused", reason };
    }
    this.#commit(accounted.state);
    return {
      action: "continue",
      prompt: renderGoalPrompt("continuation", current),
      tokensUsed: current.tokensUsed,
      ...(current.tokenBudget !== undefined ? { tokenBudget: current.tokenBudget } : {}),
    };
  }

  /** Goal context for the next turn (first turn of a freshly created goal):
   *  omp injects this into the system prompt; oma rides it as the turn's
   *  hidden input. */
  activePrompt(): string | null {
    const state = this.#state;
    if (!state?.enabled || state.goal.status !== "active") return null;
    return renderGoalPrompt("active", state.goal);
  }

  /** omp goal-todo-context: a continuation has no visible user nudge, so the
   *  live todo state must ride along or stale items silently rot. Appended
   *  to continuation/budget prompts by the caller that owns the todo file. */
  static renderTodoContext(items: readonly TodoItem[]): string {
    if (items.length === 0) return "";
    const open = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
    const done = items.length - open;
    const rows = items.map(
      (i) => `- [${i.status === "in_progress" ? "in_progress" : i.status}] ${i.text}`,
    );
    return [
      "<todo_context>",
      "Persisted todos: live progress state for the current goal, not old transcript decoration; goal continuations lack a visible user nudge → treat as live state.",
      "Before substantial work: compare the next action with the todos. If an item is stale, already finished, or no longer the active pointer, call `todo` first: mark it done or rewrite the list. Do not leave a stale in_progress while working on later phases.",
      "",
      `Overall: ${done}/${items.length} done, ${open} open.`,
      ...rows,
      "</todo_context>",
    ].join("\n");
  }
}
