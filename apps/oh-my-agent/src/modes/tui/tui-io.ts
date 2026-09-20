import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskQuestionResult } from "@chengchenccc/agent-contract";
import {
  applyBackgroundToLine,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type Terminal,
  Text,
  TUI,
  truncateToWidth,
} from "@chengchenccc/tui";
import { defaultRegistry } from "../../core/coordination/registry.js";
import {
  appendInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "../../core/session/input-history.js";
import type { ProjectSettings } from "../../core/settings/project-settings.js";
import { AskPanel } from "./ask-panel.js";
import { runBashPtyConsole } from "./pty-console.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { layoutBranchTree } from "./tui-branch-layout.js";
import { HistorySearchOverlay, OmaTranscriptContainer, PickerOverlay } from "./tui-components.js";
import {
  EDITOR_THEME,
  formatSettlementText,
  type JobSettlement,
  renderSettlementRows,
  SETTLEMENT_INLINE_MAX,
  SETTLEMENT_PREVIEW_MAX,
  sessionRow,
  WELCOME_TIPS,
} from "./tui-format.js";
import { createOmaFrameProvider } from "./tui-frame-provider.js";
import { deletePickedSession } from "./tui-overlays.js";
import { TuiRenderShell } from "./tui-render.js";
import type { TuiCommand, TuiIo } from "./tui-seam.js";
import type { TuiViewState } from "./view-state.js";

/** TERMINAL WIRING: keys, editor, overlays, history, busy/status, and the
 *  TuiIo implementation the session loop drives. The pure pieces live next
 *  door — branch-tree layout in ./tui-branch-layout.ts, modal pickers in
 *  ./tui-overlays.ts, rendering in ./tui-render.ts, view state in
 *  ./view-state.ts. What is left here is genuinely the driver: it owns the
 *  terminal and the closure state the driver's callbacks share. */

export function createTerminalIo(
  terminal: Terminal = new ProcessTerminal(),
  workspaceRoot: string = process.cwd(),
): TuiIo {
  const tui = new TUI(terminal);
  const transcript = new OmaTranscriptContainer();
  const statusContainer = new Container();
  const welcomeTip = WELCOME_TIPS[Math.floor(Math.random() * WELCOME_TIPS.length)] ?? "";
  const shell = new TuiRenderShell(tui, transcript, statusContainer, workspaceRoot, welcomeTip);
  // M-bash/M-eval: background job settlements land as transcript blocks.
  // Completions are debounced 1.5s so a finishing batch lands as ONE
  // injected message. OMA_BG_INJECT=0 degrades to transcript notices
  // (model never sees them; poll via hub output instead).
  const injections: string[] = [];
  function injectUserMessage(text: string): void {
    // Prefer a live waiter; otherwise queue for the next waitForInput.
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(text);
      return;
    }
    injections.push(text);
  }
  const bgPending: JobSettlement[] = [];
  let bgDebounce: Timer | undefined;
  defaultRegistry.setCompletionListener((e) => {
    const durationMs = (e.finishedAt ?? Date.now()) - e.startedAt;
    // Preview gap fix: an output that fits INLINE_MAX travels WHOLE (the
    // old slice(0, PREVIEW_MAX) silently dropped 1500..4000-char tails with
    // no artifact pointer); only spilled (> INLINE_MAX) outputs preview.
    const fullText = e.kind === "subagent" ? (e.result?.text ?? e.partialText) : (e.output ?? "");
    const spilled = fullText.length > SETTLEMENT_INLINE_MAX;
    let settlement: JobSettlement;
    if (e.kind === "subagent") {
      const ok = e.status === "completed";
      const full = e.result?.text?.trim() || e.partialText.trim();
      settlement = {
        id: e.id,
        kindLabel: e.label,
        outcome: ok ? "ok" : e.status,
        ok,
        durationMs,
        preview: spilled ? full.slice(0, SETTLEMENT_PREVIEW_MAX) : full,
      };
    } else {
      const killed = e.killed === true;
      const timedOut = e.timedOut === true;
      const ok =
        !killed &&
        !timedOut &&
        (e.exitCode === null || e.exitCode === undefined || e.exitCode === 0);
      let outcome = "finished";
      if (killed) outcome = "killed";
      else if (timedOut) outcome = "timed out";
      else if (e.exitCode !== null && e.exitCode !== undefined) outcome = `exit ${e.exitCode}`;
      const full = e.output ?? "";
      settlement = {
        id: e.id,
        kindLabel: e.kind,
        outcome,
        ok,
        durationMs,
        preview: spilled ? full.trim().slice(0, SETTLEMENT_PREVIEW_MAX) : full.trim(),
      };
    }
    // Spill FIRST, unconditionally: the artifact is the full-output record
    // for a job whose delivery may still be suppressed below — a hub
    // snapshot that already carried the result must not also be the reason
    // the only copy of the tail is lost.
    if (spilled) {
      const artifactDir = join(workspaceRoot, ".oma", "artifacts");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${e.id}.txt`), fullText, "utf8");
      // Publish a WORKSPACE-RELATIVE pointer: the model's cwd is the
      // workspace, and an absolute path goes stale the moment the workspace
      // is moved or the session is resumed elsewhere.
      settlement.artifactPath = join(".oma", "artifacts", `${e.id}.txt`);
    }
    bgPending.push(settlement);
    clearTimeout(bgDebounce);
    if (process.env.OMA_BG_INJECT === "0") {
      // Display-only: the transcript block lands, the model never sees it
      // (poll via hub output instead).
      shell.appendNotice(renderSettlementRows(bgPending));
      bgPending.length = 0;
      return;
    }
    bgDebounce = setTimeout(() => {
      const batch = bgPending.splice(0);
      if (batch.length === 0) return;
      // Suppression is decided HERE, not at settle time: a blocking task
      // batch (or the model's own hub snapshot) acknowledges its handles a
      // few milliseconds AFTER the synchronous completion listener queued
      // them, and the debounce window is 1.5s — checking at settle time let
      // every agent of a fan-out wake the model again ("already reported").
      const live = batch.filter((s) => !defaultRegistry.isDeliveryAcknowledged(s.id));
      if (live.length === 0) return;
      shell.appendNotice(renderSettlementRows(live));
      injectUserMessage(formatSettlementText(live));
    }, 1_500);
    bgDebounce.unref?.();
  });
  const editorTheme: EditorTheme = {
    ...EDITOR_THEME,
    topBorder: (width: number): string => {
      if (!shell.statusLineText) return EDITOR_THEME.borderColor("─".repeat(width));
      // Re-fit the powerline status bar to the current width. The raw string
      // is width-independent; addStatusBar must not pre-truncate it, or a
      // terminal resize leaves a stale-width status line above the editor.
      const line = truncateToWidth(shell.statusLineText, width, "");
      return applyBackgroundToLine(line, width, (s) => `\u001b[48;5;234m${s}\u001b[0m`);
    },
  };
  const editor = new Editor(tui, editorTheme);
  // DOCKED HITL panel (ask_question). While it is live it takes the editor's
  // place at the bottom of the frame and owns the keyboard; the provider
  // resolves the slot per frame, so nothing has to be unmounted. `dock`/`undock`
  // are the only way in and out (undock restores focus to the editor).
  //
  // `dismiss` is the panel's settle-once entry point and exists because a
  // docked panel outlives nothing: once the run it belongs to is gone (user
  // abort) the ask has to resolve too, or the panel stays docked swallowing
  // every keystroke with no run left to answer.
  let docked: { panel: AskPanel; dismiss: () => void } | null = null;
  function dock(panel: AskPanel, dismiss: () => void): void {
    docked = { panel, dismiss };
    tui.setFocus(panel);
    tui.requestRender();
  }
  function undock(panel: AskPanel): void {
    if (docked?.panel === panel) docked = null;
    tui.setFocus(editor);
    tui.requestRender();
  }
  // The header is emitted by setHeader() once the session identity is known
  // (runTuiSession always calls it). Rendering here too would print a second,
  // session-less banner into the transcript.
  let pending: ((value: string | null) => void) | null = null;
  let busy = false;
  let liveHandler: ((text: string) => void) | null = null;
  let liveCommandHandler: ((text: string) => void) | null = null;
  let commandHandler: ((cmd: TuiCommand) => void) | null = null;
  let focusHandler: ((focused: boolean) => void) | null = null;
  let loader: Loader | null = null;
  let busySince = 0;
  let busySeconds = 0;
  let elapsedTimer: Timer | undefined;
  let focused = true;

  // Persistent prompt history (pi's HistoryStorage): loaded newest-first,
  // fed to the editor (up/down recall, in-memory cap 100) and appended on
  // every submit — idle prompts AND live steers both pass through
  // editor.onSubmit, the single choke point. Drained follow-ups were already
  // recorded at steer time.
  let historyEntries: readonly string[] = loadInputHistory();
  for (const prompt of historyEntries.slice(0, 100).reverse()) {
    editor.addToHistory(prompt);
  }

  // Idle Ctrl-C quits only on a SECOND press within 2s (a stray press must
  // not kill the session); busy Ctrl-C stays single-press because aborting
  // a run is not destructive. Ctrl-D remains an instant quit.
  let quitArmed = false;
  let quitHint: Text | null = null;
  let quitTimer: Timer | undefined;
  let escArmed = false;
  let escTimer: Timer | undefined;
  let escHint: Text | null = null;

  function startElapsedTimer(): void {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!busy) return;
      busySeconds = Math.floor((Date.now() - busySince) / 1000);
      shell.setBusySeconds(busySeconds);
      shell.updateWorkingMessage();
    }, 1000);
  }

  /** ADR 0028: chrome repaint cadence while busy — animates the pinned
   *  live-agent block (and any other chrome shimmer) without touching the
   *  transcript's scrollback-committed rows. */
  const CHROME_REPAINT_MS = 100;
  let chromeRepaintTimer: Timer | undefined;

  /** Derive a short human-readable summary for the currently streaming
   *  activity (omp's intent/working message). Prefer a live tool intent;
   *  when the model is composing a response, surface the first line of its
   *  thinking or output so the composer is never just "working…". */

  function dismissQuitHint(): void {
    quitArmed = false;
    clearTimeout(quitTimer);
    if (quitHint) {
      statusContainer.removeChild(quitHint);
      quitHint = null;
    }
  }

  function armQuit(): void {
    quitArmed = true;
    quitHint = new Text("\u001b[33m  press ctrl+c again to quit\u001b[0m", 0, 0);
    statusContainer.addChild(quitHint);
    tui.requestRender();
    quitTimer = setTimeout(() => {
      dismissQuitHint();
      tui.requestRender();
    }, 2_000);
  }
  /** Idle esc-esc opens the branch tree. A single esc only arms so the esc
   *  that CLOSES an overlay can never immediately re-summon it. */
  function dismissEscArm(): void {
    escArmed = false;
    clearTimeout(escTimer);
    if (escHint) {
      statusContainer.removeChild(escHint);
      escHint = null;
    }
  }

  function armEsc(): void {
    dismissEscArm();
    escArmed = true;
    escHint = new Text("\u001b[2m  press esc again for branch tree\u001b[0m", 0, 0);
    statusContainer.addChild(escHint);
    tui.requestRender();
    escTimer = setTimeout(() => {
      dismissEscArm();
      tui.requestRender();
    }, 2_000);
  }

  function recordHistory(prompt: string): void {
    const next = appendInputHistory(historyEntries, prompt);
    if (next === historyEntries) return;
    historyEntries = next;
    saveInputHistory(historyEntries);
    editor.addToHistory(prompt);
  }

  editor.onSubmit = (text) => {
    if (busy) {
      const trimmed = text.trim();
      // Slash commands execute live (pi's LiveCommandController) instead of
      // being steered into the model as literal text; anything else steers
      // immediately — the session loop queues a rejected steer as the next
      // Run's input, so nothing is lost either way.
      // Empty submit while busy = omp's "stop waiting": the session loop
      // interrupts the run so queued input is processed immediately.
      if (!trimmed) {
        if (liveHandler) liveHandler("");
        return;
      }
      if (trimmed.startsWith("/")) {
        if (liveCommandHandler) liveCommandHandler(trimmed);
        return;
      }
      recordHistory(trimmed);
      if (liveHandler) liveHandler(trimmed);
      return;
    }
    dismissEscArm();
    if (!pending) return;
    const resolve = pending;
    pending = null;
    if (text === "/exit" || text === "/quit") {
      resolve(null);
      return;
    }
    recordHistory(text);
    resolve(text);
  };
  // Esc/ctrl+t/ctrl+o are intercepted before the editor sees them. Esc
  // aborts a live run (pi's app.interrupt); ctrl+t and ctrl+o toggle the
  // thinking-block and tool-detail views globally.
  // Last rendered state: resize/setHeader rebuild the transcript from it.

  tui.addInputListener((data) => {
    // Focus reporting (CSI 1004): ESC[I focused, ESC[O unfocused.
    if (data === "\x1b[I") {
      focused = true;
      focusHandler?.(true);
      return { consume: true };
    }
    if (data === "\x1b[O") {
      focused = false;
      focusHandler?.(false);
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      // An overlay must own Esc: abort/forkTree must not steal the key while
      // the user is trying to cancel the overlay, or it becomes impossible to
      // close (e.g. branch-tree picker). A DOCKED panel has the same claim —
      // it is the surface the user is looking at, and Esc there means "cancel
      // the question", not "abort the run it came from".
      if (tui.hasOverlay() || docked !== null) return undefined;
      if (busy) {
        if (commandHandler) commandHandler("abort");
        return { consume: true };
      }
      if (!editor.isShowingAutocomplete() && commandHandler) {
        // esc-esc summons; the first esc only arms (quit-arm pattern) so an
        // extra esc while dismissing overlays never reopens the tree.
        if (escArmed) {
          dismissEscArm();
          commandHandler("forkTree");
        } else {
          armEsc();
        }
        return { consume: true };
      }
    }
    if (matchesKey(data, "ctrl+t")) {
      if (commandHandler) commandHandler("toggleThinking");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      if (commandHandler) commandHandler("toggleToolDetail");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+p")) {
      if (commandHandler) commandHandler("pickModel");
      return { consume: true };
    }
    // ctrl+r: search the persistent prompt history (pi's history search).
    if (matchesKey(data, "ctrl+r")) {
      openHistorySearch();
      return { consume: true };
    }
    // ctrl+c aborts the live run when busy and quits when idle.
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        // The abort tears the run down; a pending ask must be resolved with it
        // (the panel would otherwise stay docked with nothing behind it).
        docked?.dismiss();
        if (commandHandler) commandHandler("abort");
      } else if (pending) {
        // Idle: the second press within 2s quits; the first just arms.
        if (quitArmed) {
          dismissQuitHint();
          const resolve = pending;
          pending = null;
          resolve(null);
        } else {
          armQuit();
        }
      }
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  function openHistorySearch(): void {
    if (historyEntries.length === 0) {
      const hint = new Text("\u001b[2m  history is empty\u001b[0m", 0, 0);
      statusContainer.addChild(hint);
      tui.requestRender();
      setTimeout(() => {
        statusContainer.removeChild(hint);
        tui.requestRender();
      }, 1_500);
      return;
    }
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const overlayBox = new HistorySearchOverlay(
      new Text("  history search — filter, enter, esc", 0, 0),
      historyEntries,
      EDITOR_THEME.selectList,
      (value) => {
        overlay.hide();
        resolve(value);
      },
      () => {
        overlay.hide();
        resolve(null);
      },
    );
    const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
    void promise.then((value) => {
      if (value !== null) editor.setText(value);
      tui.requestRender();
    });
  }

  tui.setFrameProvider(
    createOmaFrameProvider({
      transcript,
      statusContainer,
      editor,
      shell,
      bottom: () => docked?.panel ?? editor,
    }),
  );
  tui.addChild(transcript);
  tui.addChild(statusContainer);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  tui.terminal.write("\x1b[?1004h");

  return {
    render(state: TuiViewState) {
      shell.render(state);
    },
    waitForInput() {
      const queued = injections.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },

    setBusy(next: boolean) {
      busy = next;
      // The animated status line: a braille spinner + "working (Ns)" while
      // a run is live, removed when it settles. Loader drives its own timer
      // and calls requestRender on every frame; the elapsed timer ticks the
      // seconds; the chrome repaint driver (ADR 0028) animates the pinned
      // live-agent block — chrome has no scrollback semantics, so a fixed
      // cadence timer is safe there (the transcript never gets one).
      statusContainer.clear();
      if (next) {
        shell.addStatusBar();
        shell.setBusy(true, null, 0);
        busySince = Date.now();
        busySeconds = 0;
        shell.setBusySeconds(0);
        loader = new Loader(
          tui,
          (s) => `\u001b[36m${s}\u001b[0m`,
          (s) => `\u001b[2m${s}\u001b[0m`,
          "working… (esc to abort)",
        );
        loader.start();
        statusContainer.addChild(loader);
        shell.setBusy(true, loader, 0);
        shell.updateWorkingMessage();
        startElapsedTimer();
        chromeRepaintTimer = setInterval(() => tui.requestRender(), CHROME_REPAINT_MS);
        chromeRepaintTimer.unref?.();
      } else {
        clearInterval(elapsedTimer);
        clearInterval(chromeRepaintTimer);
        busySeconds = 0;
        if (loader) {
          loader.stop();
          loader = null;
        }
        shell.setBusy(false, null, 0);
        shell.renderIdleFooter();
      }
      tui.requestRender();
    },
    setQueuedCount(count: number) {
      shell.setQueuedCount(count);
    },
    onLiveInput(handler) {
      liveHandler = handler;
    },
    onLiveCommand(handler) {
      liveCommandHandler = handler;
    },
    onCommand(handler) {
      commandHandler = handler;
    },
    onFocus(handler) {
      focusHandler = handler;
    },
    setSlashCommands(commands) {
      // Registers slash-command autocomplete; also enables @-file completion
      // over the workspace as a side effect of the combined provider.
      editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider([...commands], workspaceRoot),
      );
    },
    pickSession(sessions, currentSessionId) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const rows = [...sessions];
      const build = (): Array<{ value: string; label: string; description: string }> =>
        rows.map((s) => {
          // One row shape for every resume surface (see sessionRow): the time
          // column carries the absolute stamp AND the relative age, so the
          // "3h ago" reading never costs the sortable order.
          const { label, description } = sessionRow(s);
          return { value: s.id, label, description };
        });
      const HINT = "  resume session — select, enter, ctrl+d delete, esc";
      const header = new Text(HINT, 0, 0);
      // The label column is sized for `MM-DD HH:MM · 3h ago` (~20 cells) and
      // the wide past-year form `2025-09-20 14:05 · 12mo ago` (26): the
      // previous 6..8 clamp silently truncated the stamp to "09-20", dropping
      // the time the newest-first order is read from.
      const list = new SelectList(build(), 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 28,
      });
      const overlayBox = new PickerOverlay(header, list);
      // Wider than the other pickers: a resume row carries time + age + title
      // + summary, and the summary is the part worth reading (a 60% overlay
      // cut it off mid-word at 100 columns).
      const overlay = tui.showOverlay(overlayBox, { width: "80%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value);
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      list.onDelete = (item) => {
        const note = (text: string): void => {
          header.setText(text);
          tui.requestRender();
        };
        const outcome = deletePickedSession(rows, item.value, currentSessionId);
        if (!outcome.deleted) {
          if (outcome.message) note(`  ${outcome.message}`);
          return;
        }
        const index = rows.findIndex((s) => s.id === item.value);
        if (index !== -1) rows.splice(index, 1);
        list.setItems(build());
        note(rows.length === 0 ? "  no sessions left — esc to close" : HINT);
      };
      return promise;
    },
    pickModel(models) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const items = models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.description,
      }));
      const list = new SelectList(items, 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 32,
      });
      const overlayBox = new PickerOverlay(
        new Text("  pick model — select, enter, esc", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value);
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    confirmApproval(req) {
      const { promise, resolve } = Promise.withResolvers<"allow" | "deny" | null>();
      const list = new SelectList(
        [
          { value: "allow", label: "allow", description: "run the tool" },
          { value: "deny", label: "deny", description: "block with an error result" },
        ],
        2,
        EDITOR_THEME.selectList,
        { minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: 8 },
      );
      const overlayBox = new PickerOverlay(
        new Text(
          `  approve ${req.toolName}${req.reason ? ` — ${req.reason}` : ""} — select, enter, esc`,
          0,
          0,
        ),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value === "allow" ? "allow" : "deny");
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    askQuestions(input) {
      // DOCKED panel, not an overlay: the model is blocked on this answer, so
      // the surface must not look like one more transient picker (and it must
      // not cover the row the user is typing in). Multi-select, free text and
      // the Other row are all supported here — the previous single-select
      // overlay degraded text/multi to a notice and failed the tool closed.
      const { promise, resolve } = Promise.withResolvers<AskQuestionResult | null>();
      const panel = new AskPanel(input, {
        onSettle: (result) => {
          undock(panel);
          resolve(result);
        },
        requestRender: () => tui.requestRender(),
      });
      dock(panel, () => {
        undock(panel);
        resolve(null);
      });
      return promise;
    },
    pickForkPoint(points) {
      const { promise, resolve } = Promise.withResolvers<number | null>();
      const items = points.map((p) => ({
        value: String(p.ordinal),
        label: `#${p.ordinal}`,
        description: p.text,
      }));
      const list = new SelectList(items, 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 4,
        maxPrimaryColumnWidth: 6,
      });
      const overlayBox = new PickerOverlay(
        new Text("  fork from message — select, enter, esc", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(Number(item.value));
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    pickBranchTree(nodes) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      // Git-graph layout (pi tree-selector): a node's indent only grows at
      // branch points — single-child chains stay flat, so a linear session
      // renders as one column instead of one-indent-per-message. Rails:
      // "│" at ancestor fork columns, "├─/└─" for children of a fork.
      const items = layoutBranchTree(nodes)
        .slice(0, 200)
        .map(({ node: n, prefix }) => {
          const roleColor =
            n.role === "user" ? "\u001b[36m" : n.role === "assistant" ? "\u001b[32m" : "\u001b[2m";
          const ordinal = n.ordinal !== undefined ? ` #${n.ordinal}` : "";
          return {
            value: n.id,
            label: `${prefix}${roleColor}${n.role}${ordinal}\u001b[0m`,
            description: n.text.replace(/\s+/g, " ").slice(0, 60),
          };
        });
      const list = new SelectList(items, 12, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 14,
        maxPrimaryColumnWidth: 32,
      });
      const overlayBox = new PickerOverlay(
        new Text("  fork from branch node — select, enter, esc-esc to open", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "75%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value);
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    editSettings(settings) {
      const { promise, resolve } = Promise.withResolvers<ProjectSettings | null>();
      const box = new SettingsOverlay(settings, () => {
        handle.hide();
        resolve(box.getSettings());
      });
      const handle = tui.showOverlay(box, { width: "70%", anchor: "center" });
      return promise;
    },
    runPtyConsole(command, cwd, env) {
      return runBashPtyConsole(tui, { command, cwd, env });
    },
    setHeader(info) {
      shell.setHeader(info.model ?? "", info.sessionId ?? "", info.title ?? "", info.context);
    },
    setInputText(text) {
      editor.setText(text);
      tui.requestRender();
    },
    isFocused() {
      return focused;
    },
    notify() {
      tui.terminal.write("\x07");
    },
    close() {
      clearInterval(elapsedTimer);
      clearInterval(chromeRepaintTimer);
      clearTimeout(quitTimer);
      clearTimeout(escTimer);
      dismissQuitHint();
      dismissEscArm();
      if (loader) loader.stop();
      tui.terminal.write("\x1b[?1004l");
      tui.stop();
    },
  };
}
