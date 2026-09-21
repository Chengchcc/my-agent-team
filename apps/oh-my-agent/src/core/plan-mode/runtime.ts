import {
  enterPlanMode,
  type PlanModeState,
  planIsSubstantial,
  planPathFor,
  planTitle,
  readPlan,
  writePlan,
} from "./state.js";

/** Plan mode's runtime: the session-scoped state machine, extracted from the
 *  TUI closure so it matches the other two turn drivers (goal, loop) — those
 *  are classes their surface merely renders, while plan's five loose variables
 *  were spread across twenty call sites. It owns mode state, the draft, the
 *  contract/reminder bookkeeping and the model swap; the TUI owns the review
 *  surface, because that is presentation. */

export type PlanLoopDecision =
  /** The turn produced a usable draft: nothing to queue. */
  | { action: "idle"; draftTitle?: string }
  /** No usable draft yet and the reminder budget allows one: restate the
   *  contract as the next turn. */
  | { action: "remind" }
  /** No usable draft and the reminder is spent: say so, queue nothing. */
  | { action: "stalled" };

export class PlanRuntime {
  #state: PlanModeState | null = null;
  #paused = false;
  #contractSent = false;
  #reminders = 0;
  /** Model that was active before the planning model took over. */
  #priorModel: string | undefined;

  constructor(
    /** Workspace root: plan paths live under it. */
    private readonly workspaceRoot: string,
    /** Persist a mode transition (session event); `null` = mode off. */
    private readonly persist: (state: PlanModeState | null, paused: boolean) => void = () => {},
    /** The model to plan with; absent = do not touch the model. */
    private readonly planModel: string | undefined = undefined,
  ) {}

  get state(): PlanModeState | null {
    return this.#state;
  }

  get enabled(): boolean {
    return this.#state?.enabled === true && !this.#paused;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** The draft path, or undefined when plan mode is off. */
  get draftPath(): string | undefined {
    return this.#state?.planPath;
  }

  /** Model the session should be on right now: the plan model while planning,
   *  otherwise whatever was active before (undefined = leave it alone). */
  get activeModel(): string | undefined {
    if (this.#state?.enabled === true && this.planModel) return this.planModel;
    return this.#priorModel;
  }

  /** The guard the file tools need while planning: the ONE writable path. */
  get writeGuard(): { planPath: string } | undefined {
    const path = this.draftPath;
    return this.enabled && path !== undefined ? { planPath: path } : undefined;
  }

  /** The status-bar indicator: the driver owns its wording. */
  statusLabel(): string | undefined {
    const state = this.#state;
    if (!state) return undefined;
    const draft = this.hasDraft() ? " · draft" : "";
    return `✎ plan${this.#paused ? " paused" : ""}${draft}`;
  }

  /** Enter (or re-enter after a pause). A re-entry keeps the draft and does
   *  not re-arm the contract: the model already has it in context. */
  enter(sessionId: string, reentry = false): PlanModeState {
    const path = planPathFor(this.workspaceRoot, sessionId);
    this.#state = enterPlanMode(path, reentry);
    this.#paused = false;
    if (!reentry) {
      this.#contractSent = false;
      this.#reminders = 0;
    }
    this.persist(this.#state, false);
    return this.#state;
  }

  /** Active → paused: the draft and the mode stay, no turn is driven. */
  pause(): void {
    if (!this.#state) return;
    this.#paused = true;
    this.persist(this.#state, true);
  }

  /** Fully off (the draft file stays on disk for /plan-review). The prior
   *  model is KEPT: the surface restores it immediately after leaving, so
   *  clearing it here would strand the session on the planning model. */
  leave(): void {
    if (!this.#state && !this.#paused) return;
    this.#state = null;
    this.#paused = false;
    this.#contractSent = false;
    this.#reminders = 0;
    this.persist(null, false);
  }

  /** Restore from a session's journal: a session that was planning comes back
   *  PAUSED, so a resume never silently re-enters a read-only turn. */
  restore(restored: { planPath: string } | null, sessionId: string): void {
    if (!restored) {
      this.#state = null;
      this.#paused = false;
    } else {
      this.#state = enterPlanMode(
        restored.planPath || planPathFor(this.workspaceRoot, sessionId),
        true,
      );
      this.#paused = true;
    }
    this.#contractSent = false;
    this.#reminders = 0;
    this.#priorModel = undefined;
  }

  /** Record the model the session was on when planning started (called by the
   *  surface that performs the switch; undefined is a no-op). */
  notePriorModel(modelId: string | undefined): void {
    if (modelId !== undefined) this.#priorModel ??= modelId;
  }

  readDraft(): string | null {
    const path = this.draftPath;
    return path === undefined ? null : readPlan(path);
  }

  hasDraft(): boolean {
    const markdown = this.readDraft();
    return markdown !== null && planIsSubstantial(markdown);
  }

  draftTitle(): string | undefined {
    const markdown = this.readDraft();
    return markdown ? planTitle(markdown) : undefined;
  }

  /** The contract prompt, ONCE per entry (it is long, and the mode is sticky).
   *  Null when it was already delivered. */
  takeContractPrompt(render: (state: PlanModeState) => string): string | null {
    if (this.#state?.enabled !== true || this.#paused || this.#contractSent) return null;
    this.#contractSent = true;
    return render(this.#state);
  }

  /** A user turn resets the reminder budget: they just spoke, so the model
   *  gets another chance to draft. */
  onUserTurn(): void {
    this.#reminders = 0;
  }

  /** A planning turn settled: did it produce a plan? The draft is checked
   *  FIRST — the reminder budget answers "may we nudge again", never "is there
   *  a plan". */
  settleTurn(): PlanLoopDecision {
    if (this.#state?.enabled !== true || this.#paused) return { action: "idle" };
    const markdown = this.readDraft();
    if (markdown !== null && planIsSubstantial(markdown)) {
      this.#reminders = 0;
      const title = planTitle(markdown);
      return title ? { action: "idle", draftTitle: title } : { action: "idle" };
    }
    if (this.#reminders < 1) {
      this.#reminders += 1;
      return { action: "remind" };
    }
    return { action: "stalled" };
  }

  /** Refinement re-arms planning on the SAME draft (the caller wraps the
   *  feedback as the turn's input). */
  refine(sessionId: string): PlanModeState {
    if (!this.#state) return this.enter(sessionId, true);
    this.#paused = false;
    this.#reminders = 0;
    this.persist(this.#state, false);
    return this.#state;
  }

  /** Save the draft elsewhere and stop planning without executing. */
  saveCopy(destination: string): boolean {
    const markdown = this.readDraft();
    if (markdown === null) return false;
    writePlan(destination, markdown);
    return true;
  }
}
