import { randomUUID } from "node:crypto";
import type { BackendRunInput, BackendRunOutcome } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import { ProcessTerminal } from "@chengchenccc/tui";
import type { PermissionFlag } from "../../cli/args.js";
import { buildCliRunInput } from "../../cli/initial-input.js";
import { defaultRegistry } from "../../core/coordination/registry.js";
import type { OmaLoopEvent } from "../../core/index.js";
import { vectorMemoryEnabled } from "../../core/memory/vector-memory.js";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import { resolvePermissionMode } from "../../core/settings/project-settings.js";

/** One interactive TUI session per process; the coordination scope stays
 *  stable across Runs so subagent handles survive follow-ups in this
 *  process (registry is keyed by scope, not runId). */
const COORDINATION_SCOPE = `tui-${process.pid}`;

import { appendSessionMessages, listSessions } from "../../core/session/session-file.js";
import { persistSessionTurn, resolveSession } from "../../core/session/session-loop.js";
import { loadProjectSettings } from "../../core/settings/project-settings.js";
import { readTodoFile } from "../../core/tools/todo-store.js";
import { buildCommands, type TuiSessionContext } from "./tui-commands.js";
import { formatTokens } from "./tui-format.js";
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
  let session = resolveSession(opts.sessionId);
  const state = initialViewState();
  hydrateTranscript(state, session.messages);
  // Live-chrome seed: the workspace todo file persists across sessions;
  // todo_update events keep the snapshot fresh while runs stream.
  state.todoItems = readTodoFile(opts.workspaceRoot);
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
    if (!fromFollowUp) addUserInput(state, text);

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
    modelId = built.run.model.modelId;
    // /workflow queued a script: this run executes the vm workflow instead
    // of a conversational loop (create-runtime branches on input.workflow).
    let runInput: BackendRunInput<"oma"> = built;
    if (pendingWorkflowScript !== undefined) {
      runInput = { ...built, workflow: { script: pendingWorkflowScript } };
      pendingWorkflowScript = undefined;
    }
    const pluginRt = await assemblePluginRuntime(opts.workspaceRoot, "tui");
    for (const w of pluginRt.warnings) pushStatus(`[plugin] ${w}`);
    const runtime = await createOmaRuntime({
      coordinationScope: COORDINATION_SCOPE,
      // One registry for the whole TUI process: subagent handles and the
      // bg-job chip survive follow-up Runs (the io layer listens on it).
      registry: defaultRegistry,
      runId: `tui-${randomUUID()}`,
      modelId: built.run.model.modelId,
      workspaceRoot: opts.workspaceRoot,
      workspaceAccess: opts.readOnly ? "read_only" : "read_write",
      modelRuntime: opts.modelRuntime,
      skillRoots: built.run.skillRoots ?? [],
      gateWorkspaceMcp: true,
      // M-bash: pty:true bash calls open the interactive console overlay.
      bashPtyConsole: (command, cwd, env) => io.runPtyConsole!(command, cwd, env),
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
      // HITL ask_question: interactive overlay; absent/cancel = null (tool
      // fails closed with "no answer").
      ...(io.askQuestions ? { askHandler: io.askQuestions } : {}),
      ...(pluginRt.plugins.length || pluginRt.mcpServers.length
        ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
        : {}),
      ...(built.run.permissionMode ? { permissionMode: built.run.permissionMode } : {}),
      ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
      vectorMemory: vectorMemoryEnabled(built.workspace.root),
      sessionTranscript: session.messages.length
        ? session.messages.map((m, i) => ({
            productEntryId: `session:${i}`,
            message: m as never,
          }))
        : undefined,
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
        appendSessionMessages(session.sessionId, opts.workspaceRoot, messages, session.dir);
        // The session file is wire-loose; the in-memory transcript keeps the
        // same loose shape so it round-trips into sessionTranscript verbatim.
        session.messages = [
          ...session.messages,
          ...messages.map((m) => ({ ...m }) as Record<string, unknown>),
        ];
      },
    });
    io.setBusy?.(true);
    liveRuntime = runtime;

    let outcome: BackendRunOutcome;
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
        // omp empty-submit: stop waiting — interrupt the run so queued
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
      ...(outcome.status === "completed" ? { title: outcome.title } : {}),
    });
    if (outcome.status === "completed") {
      sessionTitle = outcome.title ?? sessionTitle;
      io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
    }
    // Compaction happened mid-run: surface what was folded away so the
    // user knows the context was summarized.
    for (const summary of await runtime.compactions()) {
      pushStatus(`compacted: ${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}`);
    }
    // omp AutoLearn-style indicator: the run's background memory-learn pass
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
