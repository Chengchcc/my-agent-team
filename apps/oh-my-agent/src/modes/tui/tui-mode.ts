import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AskQuestionInput,
  BackendRunInput,
  BackendRunOutcome,
} from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import { ProcessTerminal } from "@chengchenccc/tui";
import type { PermissionFlag } from "../../cli/args.js";
import { buildCliRunInput } from "../../cli/initial-input.js";
import { defaultRegistry } from "../../core/coordination/registry.js";
import { createGoalPlugin, GoalRuntime } from "../../core/goals/index.js";
import type { OmaLoopEvent } from "../../core/index.js";
import { LoopRuntime } from "../../core/loops/index.js";
import {
  implementationTurn,
  PlanRuntime,
  planModePrompt,
  planPathFor,
  planRefinePrompt,
  planReminderPrompt,
  plansDir,
  planTitle,
} from "../../core/plans/index.js";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import {
  resolvePermissionMode,
  resolveRuntimeKnobs,
} from "../../core/settings/project-settings.js";
import { resolveBashSandbox } from "../../core/tools/bash-sandbox.js";

/** One interactive TUI session per process; the coordination scope stays
 *  stable across Runs so subagent handles survive follow-ups in this
 *  process (registry is keyed by scope, not runId). */
const COORDINATION_SCOPE = `tui-${process.pid}`;

import {
  appendSessionGoalCompletion,
  appendSessionGoalEvent,
  appendSessionMessages,
  appendSessionPlanEvent,
  listSessions,
  loadSessionGoalState,
  loadSessionPlanState,
  readSessionTitle,
} from "../../core/session/session-file.js";
import { persistSessionTurn, resolveSession } from "../../core/session/session-loop.js";
import { loadProjectSettings } from "../../core/settings/project-settings.js";
import { readTodoFile } from "../../core/tools/todo-store.js";
import { standaloneRuntimeOptions } from "../shared.js";
import { buildCommands, type TuiSessionContext } from "./tui-commands.js";
import {
  formatGoalInput,
  formatRalphInput,
  formatTokens,
  isHiddenInput,
  refreshGitStatus,
} from "./tui-format.js";
import {
  forkTreeInteractive,
  lastRunRecap,
  listModelRows,
  listModels,
  pickModelInteractive,
  registerIoHandlers,
} from "./tui-interactive.js";
import { createTerminalIo } from "./tui-io.js";
import type { TuiIo, TuiModeOptions } from "./tui-seam.js";
import { buildSlashSystem } from "./tui-slash.js";
import {
  addUserInput,
  applyEvent,
  applyOutcome,
  hydrateTranscript,
  initialViewState,
  settleSteeredMessages,
} from "./view-state.js";

/** addUserInput's third arg: render as a dim » pending echo (steered into
 *  a live run / queued) instead of a fresh user bubble. */
const AS_PENDING_ECHO = true;

/** TUI mode: oma's standalone interactive surface. One process = N
 *  consecutive Runs over ONE session file; each Run is its own Runtime
 *  (one Runtime = one Run invariant preserved). Enter submits; while a Run
 *  is live, Enter STEERS the message into the loop immediately (pi's
 *  streamingBehavior:"steer") and a steer rejected because the loop is
 *  settling falls back to a queue that auto-drains as the next Run's input
 *  (pi's AgentBusyError -> followUp) — no message is ever dropped. Esc
 *  aborts; ctrl+t toggles thinking; ctrl+o toggles tool detail; /exit
 *  quits.
 *
 *  All terminal wiring lives behind the TerminalIo seam so tests can drive
 *  the whole loop headlessly. */

/** A saved project model is used only when it still resolves in the catalog;
 *  a stale provider/model must not brick TUI startup. */
async function savedModelIsAvailable(
  modelRuntime: ModelRuntime,
  modelId: string,
): Promise<boolean> {
  try {
    const catalog = await modelRuntime.getCatalog();
    return catalog.models.some(
      (m) => `${m.providerId}/${m.modelId}` === modelId && m.available !== false,
    );
  } catch {
    return false;
  }
}

/** The full interactive session loop, driver-agnostic. */
export async function runTuiSession(opts: TuiModeOptions, io: TuiIo): Promise<number> {
  // Kick the async git refresh immediately (fire-and-forget: boot stays
  // synchronous until the io handlers are registered, and no sync spawn
  // ever blocks the Enter path). The cold-boot header card may miss the
  // git line; the status bar shows it as soon as the cache lands.
  void refreshGitStatus(opts.workspaceRoot);
  let session = resolveSession(opts.sessionId);
  const state = initialViewState();
  hydrateTranscript(state, session.messages);
  // Live-chrome seed: todo is SESSION-scoped (.oma/todo/<id>.json);
  // todo_update events keep the snapshot fresh while runs stream.
  state.todoItems = readTodoFile(opts.workspaceRoot, session.sessionId);
  let modelId: string | undefined;
  if (opts.model) {
    modelId = opts.model;
  } else {
    const saved = loadProjectSettings(opts.workspaceRoot).model;
    modelId = saved && (await savedModelIsAvailable(opts.modelRuntime, saved)) ? saved : undefined;
  }
  let liveRuntime: OmaRuntime | null = null;
  let sessionTitle: string | undefined;
  let quitting = false;
  let exitArmed = false;
  /** Estimated context tokens after the last run: drives the picker's
   *  over-context warning (pi grays out models smaller than the session). */
  let lastContextTokens: number | undefined;
  /** Recap shown when the terminal regains focus after an unfocused run. */
  let pendingFocusRecap: string | undefined;
  /** Prompt queued by a command (skill invocations): submitted as the next
   *  normal run. */
  let pendingPrompt: string | undefined;
  /** Workflow script queued by /workflow: injected into the next run input. */
  let pendingWorkflowScript: string | undefined;
  /** /permission session override: wins over the --permission flag and the
   *  settings file for every subsequent run this session. */
  let permissionOverride: PermissionFlag | undefined;
  /** /paste queue: rides the next submitted message, then clears. */
  let pendingImages: Array<{
    mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    base64: string;
  }> = [];

  /** Goal replay: a session that ended with a live goal restores it as PAUSED
   *  — resuming must never silently re-enter an autonomous loop; the user
   *  continues with /goal resume. Run once at boot and again after every
   *  session switch (both drivers are session-scoped). */
  function reloadSessionDrivers(opts: { keepLoop?: boolean } = {}): void {
    const restored = loadSessionGoalState(session.sessionId, session.dir);
    if (restored) {
      const isLive = restored.goal.status === "active" || restored.goal.status === "budget-limited";
      goalRuntime.restore(
        isLive
          ? { enabled: false, mode: "active", goal: { ...restored.goal, status: "paused" } }
          : restored,
      );
    } else {
      goalRuntime.restore(null);
    }
    // Plan mode: a session that was planning restores AS PAUSED — a resumed
    // session must never silently re-enter a read-only planning turn, and the
    // draft on disk is left untouched for /plan-review.
    planRuntime.restore(loadSessionPlanState(session.sessionId, session.dir), session.sessionId);
    // Loop mode is never persisted: a user-initiated session switch always
    // leaves it off. The exception is the switch the loop itself asked for
    // (`/new --keep-loop`): purging there ended every restarting loop — the
    // reset and build loops alike — one iteration after it started, which is
    // the exact budget the loop exists to spend.
    if (!opts.keepLoop) {
      loopRuntime.disable();
      io.setDriverStatus?.("loop", undefined);
    }
  }

  /** Back to the model that was active before planning (only when plan mode
   *  switched it; a re-entry never recorded one). */
  function restorePrePlanModel(): void {
    if (prePlanModel === undefined) return;
    modelId = prePlanModel;
    prePlanModel = undefined;
    io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
  }

  /** The review surface: the draft's title + a choice menu. The plan BODY is
   *  printed to the transcript first, so the user reads exactly what they are
   *  approving (oma's TUI scrolls the transcript; a second scrollable overlay
   *  would add a surface without adding information). */
  async function reviewPlan(): Promise<void> {
    const path = planRuntime.draftPath ?? planPathFor(opts.workspaceRoot, session.sessionId);
    const markdown = planRuntime.readDraft();
    if (markdown === null) {
      pushStatus("no plan draft on disk yet");
      return;
    }
    const title = planTitle(markdown) ?? "plan";
    pushStatus([`plan draft — ${title}  (${path})`, ...markdown.split("\n").slice(0, 40)]);
    io.render(state);
    if (!io.pickOption) {
      pushStatus("no picker available — use /plan to keep refining, or /plan-review again");
      return;
    }
    const choice = await io.pickOption(`review: ${title}`, [
      {
        value: "approve-fresh",
        label: "Approve and execute",
        description: "fresh session, plan only",
      },
      {
        value: "approve-compact",
        label: "Approve and compact",
        description: "summarize, then implement here",
      },
      {
        value: "approve-keep",
        label: "Approve and keep context",
        description: "implement here, transcript intact",
      },
      { value: "refine", label: "Refine plan", description: "send feedback as a planning turn" },
      {
        value: "save",
        label: "Save and quit",
        description: "write the plan elsewhere and stop planning",
      },
    ]);
    if (!choice) return;
    if (choice.startsWith("approve-")) {
      await approvePlan(choice.slice("approve-".length) as "fresh" | "compact" | "keep", markdown);
      return;
    }
    if (choice === "refine") {
      const feedback = io.promptText ? await io.promptText("feedback on the draft") : null;
      if (!feedback) {
        pushStatus("refine cancelled — /plan <follow-up> does the same thing");
        return;
      }
      const reentered = planRuntime.refine(session.sessionId);
      pendingFollowUps.push(formatGoalInput(planRefinePrompt(reentered, feedback)));
      refreshDriverStatus();
      return;
    }
    // Save and quit: a durable copy, then stop planning without executing.
    const destination = join(
      plansDir(opts.workspaceRoot),
      `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
    );
    planRuntime.saveCopy(destination);
    pushStatus(`plan saved: ${destination}`);
    planRuntime.leave();
    restorePrePlanModel();
    refreshDriverStatus();
  }

  /** Approval is the single execution gate: leave plan mode first (so the
   *  guard lifts), then hand the plan to the implementation turn through the
   *  hidden channel. The three choices differ ONLY in context handling. */
  async function approvePlan(
    context: "fresh" | "compact" | "keep",
    markdown: string,
  ): Promise<void> {
    const path = planRuntime.draftPath ?? planPathFor(opts.workspaceRoot, session.sessionId);
    planRuntime.leave();
    restorePrePlanModel();
    refreshDriverStatus();
    if (context === "fresh") {
      // Fresh conversation: the plan is self-contained, and the implementation
      // model gets the whole window instead of the planning discussion.
      session = resolveSession();
      sessionTitle = planTitle(markdown);
      hydrateTranscript(state, session.messages);
      state.todoItems = readTodoFile(opts.workspaceRoot, session.sessionId);
      io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
      pushStatus(
        `implementing the approved plan in a fresh session (${session.sessionId.slice(0, 8)})`,
      );
    } else if (context === "compact") {
      await runCommandText("/compact");
      pushStatus("implementing the approved plan (context compacted)");
    } else {
      pushStatus("implementing the approved plan (planning context kept)");
    }
    pendingFollowUps.push(formatGoalInput(implementationTurn(path, markdown, context !== "fresh")));
    io.render(state);
  }

  function pushStatus(lines: string | readonly string[], replacePrefix?: string): void {
    const items = (typeof lines === "string" ? [lines] : lines).map((text) => ({
      kind: "status" as const,
      text,
      streaming: false,
    }));
    if (replacePrefix) {
      for (let i = state.runs.length - 1; i >= 0; i--) {
        const first = state.runs[i]!.items[0];
        if (first?.kind === "status" && first.text.startsWith(replacePrefix)) {
          state.runs[i] = { items, running: false };
          return;
        }
      }
    }
    state.runs.push({ items, running: false });
  }

  /** Plan mode: investigate + draft (write/edit accept only the draft path),
   *  then review and approve. The state machine lives in PlanRuntime, like the
   *  other two drivers; this layer owns only the review surface, which is
   *  presentation. */
  const planRuntime = new PlanRuntime(
    opts.workspaceRoot,
    (state, paused) => appendSessionPlanEvent(session.sessionId, state, paused, session.dir),
    loadProjectSettings(opts.workspaceRoot).planModel,
  );
  /** The session's model before planning took over (mirrors the runtime's
   *  record so the header can be restored without a runtime getter). */
  let prePlanModel: string | undefined;
  /** Loop mode: re-submits one captured prompt after each settled turn. The
   *  limits/parsing live in core/loop-mode; this layer wires it to the session
   *  loop (capture the first prompt, re-submit on settle, pause on Esc).
   *  Its continue-condition runs under the same OS sandbox the run opted into,
   *  so a predicate cannot escape the confinement the user asked for. */
  const loopRuntime = new LoopRuntime(loadProjectSettings(opts.workspaceRoot).loopAction);
  /** Refresh every driver segment after a transition. ONE entry point: the
   *  trio of parallel refreshers is what let a transition silently show a
   *  stale bar. */
  const refreshDriverStatus = (): void => {
    io.setDriverStatus?.("plan", planRuntime.statusLabel());
    io.setDriverStatus?.("goal", goalRuntime.statusLabel());
    io.setDriverStatus?.("loop", loopRuntime.statusLabel());
  };
  const conditionSandbox = (() => {
    const settings = loadProjectSettings(opts.workspaceRoot);
    if (settings.bashSandbox !== true) return undefined;
    try {
      return resolveBashSandbox({ workspaceRoot: opts.workspaceRoot, enabled: true });
    } catch {
      // Enabled but the platform tool is missing: the RUN fails loudly on its
      // own; a condition just runs unconfined rather than blocking the loop.
      return undefined;
    }
  })();
  /** Goal runtime: owns goal state, accounting and loop decisions; the TUI
   *  renders its decisions. */
  const goalRuntime = new GoalRuntime(
    (state, recordCompletion) => {
      appendSessionGoalEvent(session.sessionId, state, session.dir);
      // A completed goal also lands as a durable achievement record, so a
      // resumed session can report WHAT was finished and at what cost — once,
      // after the final usage flush.
      if (recordCompletion && state?.goal.status === "complete") {
        appendSessionGoalCompletion(
          session.sessionId,
          {
            objective: state.goal.objective,
            tokensUsed: state.goal.tokensUsed,
            timeUsedSeconds: state.goal.timeUsedSeconds,
            ...(state.goal.tokenBudget !== undefined
              ? { tokenBudget: state.goal.tokenBudget }
              : {}),
          },
          session.dir,
        );
      }
    },
    (message) => pushStatus(`◎ ${message}`),
  );

  // Both turn drivers are session-scoped: derive their state for THIS session
  // (a live goal comes back paused; loop mode comes back off).
  reloadSessionDrivers();
  refreshDriverStatus();

  /** Compact recap text for the most recent run: last assistant message
   *  first line, falling back to the auto title. */
  io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
  // `oma "<prompt>"` opens the TUI with the prompt prefilled in the editor.
  if (opts.initialPrompt) io.setInputText?.(opts.initialPrompt);

  const ctx: TuiSessionContext = {
    state,
    io,
    opts,
    get session() {
      return session;
    },
    set session(value) {
      session = value;
    },
    get sessionTitle() {
      return sessionTitle;
    },
    set sessionTitle(value) {
      sessionTitle = value;
    },
    get modelId() {
      return modelId;
    },
    set modelId(value) {
      modelId = value;
    },
    get quitting() {
      return quitting;
    },
    set quitting(value) {
      quitting = value;
    },
    get exitArmed() {
      return exitArmed;
    },
    set exitArmed(value) {
      exitArmed = value;
    },
    get pendingPrompt() {
      return pendingPrompt;
    },
    set pendingPrompt(value) {
      pendingPrompt = value;
    },
    get pendingWorkflowScript() {
      return pendingWorkflowScript;
    },
    set pendingWorkflowScript(value) {
      pendingWorkflowScript = value;
    },
    get liveRuntime() {
      return liveRuntime;
    },
    set liveRuntime(value) {
      liveRuntime = value;
    },
    get lastContextTokens() {
      return lastContextTokens;
    },
    set lastContextTokens(value) {
      lastContextTokens = value;
    },
    get pendingFocusRecap() {
      return pendingFocusRecap;
    },
    set pendingFocusRecap(value) {
      pendingFocusRecap = value;
    },
    get permissionOverride() {
      return permissionOverride;
    },
    set permissionOverride(value) {
      permissionOverride = value;
    },
    goals: goalRuntime,
    loops: loopRuntime,
    reloadSessionDrivers,
    refreshDriverStatus,
    plans: {
      state: () => planRuntime.state,
      enter: (reentry = false) => {
        planRuntime.notePriorModel(modelId);
        planRuntime.enter(session.sessionId, reentry);
        // Planning gets its own model when configured: investigation quality
        // dominates the draft, and the implementer can differ.
        const planModel = planRuntime.activeModel;
        if (planModel && planModel !== modelId) {
          modelId = planModel;
          io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
        }
        refreshDriverStatus();
      },
      pause: () => {
        planRuntime.pause();
        refreshDriverStatus();
      },
      leave: () => {
        planRuntime.leave();
        restorePrePlanModel();
        refreshDriverStatus();
      },
      hasDraft: () => planRuntime.hasDraft(),
      draftPath: () => planRuntime.draftPath ?? planPathFor(opts.workspaceRoot, session.sessionId),
      review: () => reviewPlan(),
    },
    get pendingImages() {
      return pendingImages;
    },
    set pendingImages(value) {
      pendingImages = value;
    },

    pushStatus,
    listModels: () => listModels(ctx),
    listModelRows: () => listModelRows(ctx),
    listSessions,
    pickModelInteractive: () => pickModelInteractive(ctx),
    forkTreeInteractive: () => forkTreeInteractive(ctx),
  };
  const commands = buildCommands(ctx);

  const { slashCommands, runCommandText } = buildSlashSystem(ctx, commands);
  ctx.runCommandText = runCommandText;
  io.setSlashCommands?.(slashCommands);
  registerIoHandlers(ctx);

  io.onLiveCommand?.((text) => {
    void runCommandText(text).then(() => io.render(state));
  });

  /** `!cmd`: run a shell command locally in the PTY console (pi's bang
   *  escape). Output lands in the transcript; the model sees nothing. */
  const runShellEscape = async (text: string): Promise<void> => {
    const command = text.slice(1).trim();
    if (!command) return;
    addUserInput(state, text);
    if (!io.runPtyConsole) {
      pushStatus("shell escape not supported by this driver");
      return;
    }
    const result = await io.runPtyConsole(command, opts.workspaceRoot, {
      ...(Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined),
      ) as Record<string, string>),
    });
    const lines = [`$ ${command}`];
    if (result.tail.trim()) lines.push(...result.tail.trimEnd().split("\n"));
    lines.push(result.killed ? "[killed]" : `[exit: ${result.exitCode ?? "signal"}]`);
    pushStatus(lines);
  };

  /** Steers rejected while the loop was settling; drained as the next
   *  Run's prompt when the current Run ends (pi's followUp fallback). */
  const pendingFollowUps: string[] = [];
  /** Steers accepted into the live run but not yet drained by the loop.
   *  Empty-submit interrupts the run so these send immediately; if the run
   *  ends first, they move to pendingFollowUps — never dropped. */
  const pendingSteerTexts: string[] = [];
  for (;;) {
    io.render(state);
    // Steers that arrived while the previous loop was settling are drained
    // here as the next Run's prompt (already echoed as » items — no re-echo).
    let text: string;
    let fromFollowUp = false;
    if (pendingFollowUps.length > 0) {
      const drained = pendingFollowUps.splice(0);
      text = drained.join("\n\n");
      fromFollowUp = true;
      // Settle the queued » echoes in place — no re-echo (pi moves queued
      // messages into the chat when they are delivered).
      settleSteeredMessages(state, drained);
    } else {
      const input = await io.waitForInput();
      if (input === null) return 0;
      text = input.trim();
      if (!text) continue;
    }

    if (text.startsWith("!")) {
      void runShellEscape(text).then(() => io.render(state));
      continue;
    }
    if (text.startsWith("/")) {
      await runCommandText(text);
      if (quitting) return 0;
      // A command queued a prompt (skill invocation, workflow): submit it as
      // the next run instead of returning to the editor.
      if (pendingPrompt === undefined) continue;
      text = pendingPrompt;
      pendingPrompt = undefined;
    }

    // Queued /paste images ride this message, then clear.
    const images = pendingImages.splice(0);
    if (images.length > 0) pushStatus(`[${images.length} image(s) attached]`);
    // Settlement injections already rendered their transcript block via
    // appendNotice (tui-io) — no second echo as a user bubble.
    if (!fromFollowUp && !isHiddenInput(text)) addUserInput(state, text);
    // Loop mode: the first prompt after enabling becomes the prompt that is
    // re-submitted after every settled turn. Slash COMMANDS never qualify —
    // a command is an instruction to the session, and re-submitting "/loop"
    // or "/compact" as the loop body would re-run the command forever.
    if (!isHiddenInput(text) && !text.startsWith("/")) loopRuntime.capturePrompt(text);
    if (!isHiddenInput(text)) planRuntime.onUserTurn();

    const built = await buildCliRunInput({
      prompt: text,
      workspaceRoot: opts.workspaceRoot,
      modelRuntime: opts.modelRuntime,
      modelId,
      permissionMode: resolvePermissionMode(
        permissionOverride ?? opts.permissionMode,
        opts.workspaceRoot,
      ),
      readOnly: opts.readOnly,
      ...(images.length > 0 ? { images } : {}),
    });
    // `/workflow` queued a script: this run executes the vm workflow instead
    // of a conversational loop (create-runtime branches on input.workflow).
    let runInput: BackendRunInput<"oma"> = built;
    if (pendingWorkflowScript !== undefined) {
      runInput = { ...built, workflow: { script: pendingWorkflowScript } };
      pendingWorkflowScript = undefined;
    }
    modelId = built.run.model.modelId;
    let pluginRt = await assemblePluginRuntime(opts.workspaceRoot, "tui");
    // Goal mode : the `goal` tool is mounted for THIS run only while
    // the mode is live (active goal or /guided-goal interview). The runtime
    // owns state/accounting; this layer only decides whether to mount it.
    if (goalRuntime.toolWanted && runInput.workflow === undefined) {
      pluginRt = { ...pluginRt, plugins: [...pluginRt.plugins, createGoalPlugin(goalRuntime)] };
    }
    for (const w of pluginRt.warnings) pushStatus(`[plugin] ${w}`);
    const knobs = resolveRuntimeKnobs(loadProjectSettings(opts.workspaceRoot));
    const runtime = await createOmaRuntime(
      standaloneRuntimeOptions(
        built,
        {
          modelRuntime: opts.modelRuntime,
          ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
          session,
          pluginRt,
        },
        {
          coordinationScope: COORDINATION_SCOPE,
          // Plan mode's read-only rule lives in the file tools, so the guard
          // has to travel WITH the runtime that mounts them: an active plan
          // turn gets exactly one writable path (the draft).
          ...(planRuntime.writeGuard ? { planMode: planRuntime.writeGuard } : {}),
          // Title churn fix: once the session file carries a title, mark the
          // conversation titled so the loop stops spending a model call per
          // completed turn (the TUI re-reads it each run, so a fresh title
          // from this run lands before the next one is considered).
          settings: {
            ...knobs,
            ...(readSessionTitle(session.sessionId, session.dir) !== undefined
              ? { conversationTitled: true }
              : {}),
          },
          // One registry for the whole TUI process: subagent handles and the
          // bg-job chip survive follow-up Runs (the io layer listens on it).
          registry: defaultRegistry,
          runId: `tui-${randomUUID()}`,
          workspaceRoot: opts.workspaceRoot,
          workspaceAccess: opts.readOnly ? "read_only" : "read_write",
          // M-bash: pty:true bash calls open the interactive console overlay.
          bashPtyConsole: (command, cwd, env, signal) =>
            io.runPtyConsole!(command, cwd, env, signal),
          // HITL: interactive approval overlay; absent picker or cancel = deny.
          approvalHandler: async (req) => {
            const verdict = await io.confirmApproval?.({
              toolName: req.toolName,
              ...(req.reason ? { reason: req.reason } : {}),
            });
            return verdict === "allow"
              ? { decision: "allow" }
              : { decision: "deny", reason: "user denied" };
          },
          // HITL ask_question: docked panel; absent/cancel = null (tool fails
          // closed with "no answer"). The inactivity timeout is config, so it
          // is resolved here (the io implements the surface, the session owns
          // the knobs).
          ...(io.askQuestions
            ? {
                askHandler: (input: AskQuestionInput) =>
                  io.askQuestions!(input, {
                    ...(knobs.askTimeoutMs ? { timeoutMs: knobs.askTimeoutMs } : {}),
                  }),
              }
            : {}),
          // Render on every event so model chunks (message_update) hit the
          // screen incrementally; the TUI's requestRender throttles/coalesces,
          // so high-frequency chunk events are safe here.
          onEvent: (envelope) => {
            const event = envelope.data as OmaLoopEvent;
            applyEvent(state, event);
            // Steers the loop actually injected are no longer "queued".
            if (event.type === "queue_update" && event.drained) {
              for (const drained of event.drained) {
                const idx = pendingSteerTexts.indexOf(drained);
                if (idx >= 0) pendingSteerTexts.splice(idx, 1);
              }
              io.setQueuedCount?.(pendingSteerTexts.length);
            }
            io.render(state);
          },
          // Real-time session persistence (pi appendMessage): every
          // conversational persist (user prompt, steer, assistant, tool result)
          // lands in the session file immediately, so even a killed/failed
          // process leaves its context for the next turn.
          onPersistMessages: (messages) => {
            // Settlement injections are RUN INPUTS, not user turns: they must
            // reach the model (they are the delivery) but never enter the
            // session file, or /resume replays them as phantom user bubbles
            // ("background jobs finished" blocks the user never typed).
            const persistable = messages.filter(
              (m) => !(m.role === "user" && isHiddenInput(m.text ?? "")),
            );
            if (persistable.length === 0) return;
            appendSessionMessages(session.sessionId, opts.workspaceRoot, persistable, session.dir);
            // The session file is wire-loose; the in-memory transcript keeps the
            // same loose shape so it round-trips into sessionTranscript verbatim.
            session.messages = [
              ...session.messages,
              ...persistable.map((m) => ({ ...m }) as Record<string, unknown>),
            ];
          },
        },
      ),
    );
    io.setBusy?.(true);
    liveRuntime = runtime;

    let outcome: BackendRunOutcome;
    const turnStartedAt = Date.now();
    try {
      // Steer: a submit while the run is live injects immediately (pi's
      // streamingBehavior:"steer" — the loop buffers to a safe boundary).
      // A steer rejected because the loop is settling falls back to the
      // follow-up queue and is delivered as the next Run's input — the
      // message is never dropped (pi's AgentBusyError -> followUp).
      const steerHandler = (text: string): void => {
        // `!cmd` during a live run: local shell, never steered.
        if (text.startsWith("!")) {
          void runShellEscape(text).then(() => io.render(state));
          return;
        }
        // empty-submit: stop waiting — interrupt the run so queued
        // input is processed immediately instead of at the next boundary.
        if (!text) {
          if (pendingSteerTexts.length > 0 || pendingFollowUps.length > 0) {
            pushStatus("interrupting — queued message sends now");
            io.render(state);
            void runtime.stop();
          }
          return;
        }
        addUserInput(state, text, AS_PENDING_ECHO);
        io.render(state);
        pendingSteerTexts.push(text);
        io.setQueuedCount?.(pendingSteerTexts.length);
        runtime
          .steer({
            inputId: `steer-${randomUUID()}`,
            message: { role: "user", text },
          })
          .catch(() => {
            // Rejected because the loop is settling: the message becomes
            // the next Run's input — never dropped (pi AgentBusyError ->
            // followUp).
            const idx = pendingSteerTexts.indexOf(text);
            if (idx >= 0) pendingSteerTexts.splice(idx, 1);
            pendingFollowUps.push(text);
            pushStatus("queued: run is settling — sends when it ends");
            io.setQueuedCount?.(pendingSteerTexts.length);
            io.render(state);
          });
      };
      io.onLiveInput?.(steerHandler);
      const segment = await runtime.run(runInput);
      outcome = await segment.outcome;
      io.onLiveInput?.(null);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      io.onLiveInput?.(null);
    }
    liveRuntime = null;

    applyOutcome(state, outcome);
    io.setBusy?.(false);
    // Steers the run never drained (interrupt, maxSteps, settling race)
    // are never dropped: they become the next Run's prompt (omp's
    // post-unwind queue drain).
    if (pendingSteerTexts.length > 0) {
      pendingFollowUps.push(...pendingSteerTexts.splice(0));
      io.setQueuedCount?.(0);
    }
    // Long runs often outlast the user's attention: ping when the terminal
    // lost focus so switching back is prompted (pi's desktop-notify analog).
    if (io.isFocused?.() === false) {
      pendingFocusRecap = lastRunRecap(ctx);
      pushStatus("run finished — switch back for recap");
      io.notify?.();
    }

    // Messages were persisted in real time (onPersistMessages); only the
    // end-of-run artifacts (compaction summaries, auto title) remain.
    await persistSessionTurn({
      sessionId: session.sessionId,
      cwd: opts.workspaceRoot,
      runtime,
      dir: session.dir,
      ...(outcome.status === "completed" ? { title: outcome.title, summary: outcome.summary } : {}),
    });
    if (outcome.status === "completed") {
      sessionTitle = outcome.title ?? sessionTitle;
      io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
    }
    // Compaction happened mid-run: surface what was folded away so the
    // user knows the context was summarized.
    for (const compaction of await runtime.compactions()) {
      const summary = compaction.summary;
      pushStatus(`compacted: ${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}`);
    }
    // AutoLearn-style indicator: the run's background memory-learn pass
    // shows on the transcript without blocking the editor (the promise
    // resolves even after close()).
    const learning = runtime.memoryLearning();
    if (learning) {
      pushStatus("memory: learning…");
      io.render(state);
      void learning.then((res) => {
        pushStatus(
          res.freshFacts > 0
            ? `memory: learned ${res.freshFacts} fact${res.freshFacts === 1 ? "" : "s"}`
            : res.ran
              ? "memory: nothing new to learn"
              : "memory: skipped",
          "memory: ",
        );
        io.render(state);
      });
    }
    // Context footprint of the settled branch under the run model's window
    // (pi's context-usage display); read BEFORE close() like compactions().
    const usage = await runtime.contextUsage().catch(() => undefined);
    if (usage) lastContextTokens = usage.estimatedTokens;
    const usageParts: string[] = [];
    if (outcome.usage) {
      if (outcome.usage.inputTokens) usageParts.push(`↑${outcome.usage.inputTokens}`);
      if (outcome.usage.outputTokens) usageParts.push(`↓${outcome.usage.outputTokens}`);
      if (outcome.usage.cacheReadTokens) usageParts.push(`cache ${outcome.usage.cacheReadTokens}`);
    }
    if ((usage && usage.limit > 0) || usageParts.length > 0) {
      const ctx =
        usage && usage.limit > 0
          ? `ctx ${formatTokens(usage.estimatedTokens)}/${formatTokens(usage.limit)}`
          : "";
      const pct =
        usage && usage.limit > 0
          ? Math.min(100, Math.round((usage.estimatedTokens / usage.limit) * 100))
          : 0;
      const context = [ctx, ...(usageParts.length > 0 ? [usageParts.join(" ")] : [])]
        .filter(Boolean)
        .join(" · ");
      io.setHeader?.({
        model: modelId,
        sessionId: session.sessionId,
        title: sessionTitle,
        context: pct > 0 ? `${context} · ${pct}%` : context,
      });
    }
    await runtime.close().catch(() => {});
    // /exit (or a second ctrl+c path) may have run via the live-command
    // channel while the Run was live — honor it now that the Run settled.
    if (quitting) return 0;

    // Plan mode's contract travels WITH the turn that starts the planning: the
    // model cannot obey a rule it was never told, and the rule is the whole
    // mechanism behind the read-only guarantee for bash.
    const contract = planRuntime.takeContractPrompt(planModePrompt);
    if (contract !== null) {
      pendingFollowUps.push(formatGoalInput(contract));
    }

    // Plan mode's contract: a planning turn that produced no usable draft has
    // not done its job. One reminder (not a loop — a model that ignored the
    // contract twice needs the user, not another nudge). The runtime owns the
    // bookkeeping; this layer only renders the decision.
    if (runInput.workflow === undefined) {
      const decision = planRuntime.settleTurn();
      if (decision.action === "remind") {
        const state = planRuntime.state;
        if (state) pendingFollowUps.push(formatGoalInput(planReminderPrompt(state)));
        pushStatus("plan mode: no usable draft yet — asking the model to finish the plan");
      } else if (decision.action === "stalled") {
        pushStatus(
          "plan mode: still no plan — describe what you want more precisely, or /plan again to pause",
        );
      } else if (decision.draftTitle !== undefined) {
        pushStatus(`plan ready: ${decision.draftTitle} — /plan-review to approve`);
      }
      if (decision.action !== "idle" || decision.draftTitle !== undefined) {
        refreshDriverStatus();
        io.render(state);
      }
    }

    // Loop mode: capture the first prompt of the session's loop, then
    // re-submit it after every settled turn. Goal mode and loop mode are
    // mutually exclusive turn drivers (enabling one clears the other), so at
    // most one of these blocks queues work.
    if (loopRuntime.enabled) {
      const decision = await loopRuntime.nextIteration({
        cwd: opts.workspaceRoot,
        ...(conditionSandbox ? { sandbox: conditionSandbox } : {}),
      });
      if (decision.action === "stop") {
        pushStatus(`loop: ${loopRuntime.disable(decision.reason)}`);
        io.setDriverStatus?.("loop", undefined);
      } else if (decision.action === "run") {
        if (decision.preamble === "compact") await runCommandText("/compact");
        // --keep-loop: this session switch IS the loop, so it must survive it.
        else if (decision.preamble === "reset") await runCommandText("/new --keep-loop");
        // The loop prompt is echoed as a normal user turn (it IS the user's
        // text, unlike the hidden goal/build-loop protocol prompts).
        pendingFollowUps.push(
          decision.hidden ? formatRalphInput(decision.prompt) : decision.prompt,
        );
        pushStatus(
          decision.hidden
            ? "ralph: next item — /loop disables, Esc pauses"
            : "loop: iteration re-submitted — /loop disables, Esc pauses",
        );
        refreshDriverStatus();
      } else {
        refreshDriverStatus();
      }
      refreshDriverStatus();
      if (decision.action !== "idle") io.render(state);
    }

    // Goal mode: forward the settled turn to the runtime, which owns
    // accounting and returns the loop decision; this layer only renders it.
    if (runInput.workflow === undefined) {
      const decision = goalRuntime.settleTurn({
        usage: outcome.usage ?? {},
        wallSeconds: Math.max(0, (Date.now() - turnStartedAt) / 1000),
        status: outcome.status,
        usedTools: state.runs.at(-1)?.items.some((item) => item.kind === "tool") === true,
      });
      if (decision.action === "continue") {
        // A continuation has no visible user nudge,
        // so the live todo state must ride along (read fresh each turn — the
        // run may have rewritten it).
        const todoCtx = GoalRuntime.renderTodoContext(
          readTodoFile(opts.workspaceRoot, session.sessionId),
        );
        pendingFollowUps.push(
          formatGoalInput(`${decision.prompt}${todoCtx ? `\n\n${todoCtx}` : ""}`),
        );
        pushStatus(
          `goal continuing · ${decision.tokensUsed} tokens` +
            (decision.tokenBudget !== undefined ? `/${decision.tokenBudget}` : "") +
            " — /goal pause stops",
        );
      } else if (decision.action === "budget-wrapup") {
        // A continuation has no visible user nudge,
        // so the live todo state must ride along (read fresh each turn — the
        // run may have rewritten it).
        const todoCtx = GoalRuntime.renderTodoContext(
          readTodoFile(opts.workspaceRoot, session.sessionId),
        );
        pendingFollowUps.push(
          formatGoalInput(`${decision.prompt}${todoCtx ? `\n\n${todoCtx}` : ""}`),
        );
        pushStatus(
          `goal budget-limited (${decision.tokensUsed} ≥ ${decision.tokenBudget}) — wrap-up turn queued`,
        );
      } else if (decision.action === "completed") {
        pushStatus(`goal COMPLETE — ${decision.objective}`);
        if (decision.report) pushStatus(`  ${decision.report}`);
      }
      refreshDriverStatus();
      if (decision.action !== "idle") io.render(state);
    }
  }
}

/** CLI entry: run the interactive session over the real terminal. */
export async function runTuiMode(opts: TuiModeOptions): Promise<number> {
  const io = createTerminalIo(new ProcessTerminal(), opts.workspaceRoot);
  try {
    return await runTuiSession(opts, io);
  } finally {
    io.close();
  }
}

export { formatModelMeta } from "./tui-format.js";
export { createTerminalIo } from "./tui-io.js";
