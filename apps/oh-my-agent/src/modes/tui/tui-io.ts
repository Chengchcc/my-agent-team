import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskQuestionResult } from "@chengchenccc/message";
import {
  applyBackgroundToLine,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  type EditorTheme,
  type Focusable,
  Input,
  Loader,
  matchesKey,
  ProcessTerminal,
  renderModalFrame,
  SelectList,
  type Terminal,
  Text,
  TUI,
  tuiTheme,
  visibleWidth,
} from "@chengchenccc/tui";
import { defaultRegistry, type RegistryEntry } from "../../core/coordination/registry.js";
import {
  appendInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "../../core/session/input-history.js";
import type { ProjectSettings } from "../../core/settings/project-settings.js";
import { ApprovalPanel } from "./approval-panel.js";
import { AskPanel } from "./ask-panel.js";
import { runBashPtyConsole } from "./pty-console.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { layoutBranchTree } from "./tui-branch-layout.js";
import {
  FilterablePickerOverlay,
  HistorySearchOverlay,
  OmaTranscriptContainer,
  PickerOverlay,
} from "./tui-components.js";
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
import type { ApprovalVerdict, TuiCommand, TuiIo } from "./tui-seam.js";
import type { TuiViewState } from "./view-state.js";

/** Modal text prompt wrapped in ModalFrame (used by plan refine feedback). */
class PromptModal extends Container {
  constructor(
    private readonly title: string,
    private readonly input: Input,
  ) {
    super();
    this.addChild(input);
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const inputLines = this.input.render(innerWidth);
    return renderModalFrame({
      title: this.title,
      footer: "Enter submit · Esc cancel",
      lines: inputLines,
      width,
    });
  }
}

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
  const injections: string[] = [];
  function injectUserMessage(text: string): void {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(text);
      return;
    }
    injections.push(text);
  }
  let abortActivePty: (() => void) | null = null;
  const bgPending: JobSettlement[] = [];
  let bgDebounce: Timer | undefined;
  const onRegistrySettled = (e: RegistryEntry): void => {
    const durationMs = (e.finishedAt ?? Date.now()) - e.startedAt;
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
    if (spilled) {
      const artifactDir = join(workspaceRoot, ".oma", "artifacts");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${e.id}.txt`), fullText, "utf8");
      settlement.artifactPath = join(".oma", "artifacts", `${e.id}.txt`);
    }
    bgPending.push(settlement);
    clearTimeout(bgDebounce);
    if (process.env.OMA_BG_INJECT === "0") {
      shell.appendNotice(renderSettlementRows(bgPending));
      bgPending.length = 0;
      return;
    }
    bgDebounce = setTimeout(() => {
      const batch = bgPending.splice(0);
      if (batch.length === 0) return;
      const live = batch.filter((s) => !defaultRegistry.isDeliveryAcknowledged(s.id));
      if (live.length === 0) return;
      shell.appendNotice(renderSettlementRows(live));
      injectUserMessage(formatSettlementText(live));
    }, 1_500);
    bgDebounce.unref?.();
  };
  defaultRegistry.setCompletionListener(onRegistrySettled);

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

  const editorTheme: EditorTheme = {
    ...EDITOR_THEME,
    topBorder: (width: number): string => {
      const line = shell.renderStatusBarLine(width);
      if (!line) return `${shell.activeModeAccent()}${"─".repeat(width)}\u001b[0m`;
      return applyBackgroundToLine(line, width, (s) => `${tuiTheme.bgPanel}${s}\u001b[0m`);
    },
    promptPrefix: (visualLineIndex: number): string =>
      visualLineIndex === 0
        ? ` ${shell.activeModeAccent()}\u001b[1m❯\u001b[0m `
        : ` ${tuiTheme.dim}·\u001b[0m `,
    placeholder: (): string =>
      `${tuiTheme.dim}${
        busy ? "Type to steer live run, or /command…" : "Ask oma anything… (/help, @file, !cmd)"
      }\u001b[0m`,
    bottomBorder: (width: number): string => {
      const hints = busy
        ? " Esc abort · Enter steer · /command "
        : " Ctrl+P model · Ctrl+R history · Ctrl+O tools · /help ";
      const hintW = visibleWidth(hints);
      if (width <= hintW + 4) {
        return `${tuiTheme.faint}${"─".repeat(width)}\u001b[0m`;
      }
      const leftRule = "─".repeat(2);
      const rightRule = "─".repeat(Math.max(0, width - 2 - hintW));
      return `${tuiTheme.faint}${leftRule}\u001b[0m${tuiTheme.dim}${hints}\u001b[0m${tuiTheme.faint}${rightRule}\u001b[0m`;
    },
  };
  const editor = new Editor(tui, editorTheme);

  // DOCKED HITL slot (AskPanel and ApprovalPanel). Takes over the editor slot
  // at the bottom of the frame and owns keyboard focus until settled/dismissed.
  let docked: { panel: Component & Focusable; dismiss: () => void } | null = null;
  function dock(panel: Component & Focusable, dismiss: () => void): void {
    docked = { panel, dismiss };
    tui.setFocus(panel);
    tui.requestRender();
  }
  function undock(panel: Component & Focusable): void {
    if (docked?.panel === panel) docked = null;
    tui.setFocus(editor);
    tui.requestRender();
  }

  let historyEntries: readonly string[] = loadInputHistory();
  for (const prompt of historyEntries.slice(0, 100).reverse()) {
    editor.addToHistory(prompt);
  }

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
    quitHint = new Text(`${tuiTheme.warning}  press ctrl+c again to quit\u001b[0m`, 0, 0);
    statusContainer.addChild(quitHint);
    tui.requestRender();
    quitTimer = setTimeout(() => {
      dismissQuitHint();
      tui.requestRender();
    }, 2_000);
  }

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
    escHint = new Text(`${tuiTheme.dim}  press esc again for branch tree\u001b[0m`, 0, 0);
    statusContainer.addChild(escHint);
    tui.requestRender();
    escTimer = setTimeout(() => {
      dismissEscArm();
      tui.requestRender();
    }, 2_000);
  }

  function recordHistory(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed || trimmed.startsWith("/")) return;
    const next = appendInputHistory(historyEntries, trimmed);
    if (next === historyEntries) return;
    historyEntries = next;
    saveInputHistory(historyEntries);
    editor.addToHistory(trimmed);
  }

  editor.onSubmit = (text) => {
    if (busy) {
      const trimmed = text.trim();
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
    recordHistory(text);
    resolve(text);
  };

  tui.addInputListener((data) => {
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
      if (tui.hasOverlay() || docked !== null) return undefined;
      if (busy) {
        if (commandHandler) commandHandler("abort");
        return { consume: true };
      }
      if (!editor.isShowingAutocomplete() && commandHandler) {
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
    if (matchesKey(data, "ctrl+r")) {
      openHistorySearch();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        docked?.dismiss();
        if (commandHandler) commandHandler("abort");
      } else if (pending) {
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
      const hint = new Text(`${tuiTheme.dim}  history is empty\u001b[0m`, 0, 0);
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
      "History Search",
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
    const overlay = tui.showOverlay(overlayBox, { width: "75%", anchor: "center" });
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

  let closed = false;
  const safeRequestRender = (): void => {
    if (!closed) tui.requestRender();
  };

  return {
    render(state: TuiViewState) {
      if (closed) return;
      shell.render(state);
    },
    setDriverStatus(kind, text) {
      shell.setDriverStatus(kind, text);
    },
    promptText(title) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const input = new Input();
      const modal = new PromptModal(title, input);
      const overlay = tui.showOverlay(modal, { width: "70%", anchor: "center" });
      const previousFocus = editor;
      tui.setFocus(input);
      input.onSubmit = (value: string) => {
        overlay.hide();
        tui.setFocus(previousFocus);
        resolve(value.trim() || null);
      };
      input.onEscape = () => {
        overlay.hide();
        tui.setFocus(previousFocus);
        resolve(null);
      };
      return promise;
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
      // Loader drives an 80ms repaint timer while busy, which already animates
      // the spinner AND any shimmering todo/live-agent chrome — no second
      // out-of-phase 100ms repaint timer needed (PERF-3).
      statusContainer.clear();
      if (next) {
        shell.addStatusBar();
        shell.setBusy(true, null, 0);
        busySince = Date.now();
        busySeconds = 0;
        shell.setBusySeconds(0);
        loader = new Loader(
          tui,
          (s) => `${tuiTheme.accent}${s}\u001b[0m`,
          (s) => `${tuiTheme.dim}${s}\u001b[0m`,
          "working… (esc to abort)",
        );
        loader.start();
        statusContainer.addChild(loader);
        shell.setBusy(true, loader, 0);
        shell.updateWorkingMessage();
        startElapsedTimer();
      } else {
        clearInterval(elapsedTimer);
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
      editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider([...commands], workspaceRoot),
      );
    },
    pickSession(sessions, currentSessionId) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const rows = [...sessions];
      const build = (): Array<{ value: string; label: string; description: string }> =>
        rows.map((s) => {
          const { label, description } = sessionRow(s);
          return { value: s.id, label, description };
        });
      const overlayBox = new FilterablePickerOverlay({
        title: "Resume Session",
        placeholder: "Filter by title, summary, or date…",
        footer: "Enter open · Ctrl+D delete · ↑/↓ move · PgUp/PgDn scroll · Esc close",
        emptyMessage: "  No sessions match",
        maxVisible: 10,
        theme: EDITOR_THEME.selectList,
        layout: { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 28 },
        items: build(),
        onSelect: (item) => {
          overlay.hide();
          resolve(item.value);
        },
        onCancel: () => {
          overlay.hide();
          resolve(null);
        },
        onDelete: (item) => {
          const outcome = deletePickedSession(rows, item.value, currentSessionId);
          if (!outcome.deleted) {
            return outcome.message ?? "cannot delete session";
          }
          const index = rows.findIndex((s) => s.id === item.value);
          if (index !== -1) rows.splice(index, 1);
          if (rows.length === 0) {
            overlayBox.setStatusNote("No sessions left — Esc to close");
          }
          tui.requestRender();
          return true;
        },
      });
      const overlay = tui.showOverlay(overlayBox, { width: "82%", anchor: "center" });
      return promise;
    },
    pickModel(models) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const items = models.map((m) => ({
        value: m.id,
        label: m.id,
        ...(m.description ? { description: m.description } : {}),
      }));
      const overlayBox = new FilterablePickerOverlay({
        title: "Select Model",
        placeholder: "Filter models by provider or name…",
        footer: "Enter select · ↑/↓ move · PgUp/PgDn scroll · Esc close",
        emptyMessage: "  No matching models",
        maxVisible: 10,
        theme: EDITOR_THEME.selectList,
        layout: { minPrimaryColumnWidth: 14, maxPrimaryColumnWidth: 34 },
        items,
        onSelect: (item) => {
          overlay.hide();
          resolve(item.value);
        },
        onCancel: () => {
          overlay.hide();
          resolve(null);
        },
      });
      const overlay = tui.showOverlay(overlayBox, { width: "72%", anchor: "center" });
      return promise;
    },
    pickOption(title, options) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const list = new SelectList(
        options.map((o) => ({
          value: o.value,
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        Math.min(options.length, 8),
        EDITOR_THEME.selectList,
        { minPrimaryColumnWidth: 10, maxPrimaryColumnWidth: 28, emptyMessage: "  No options" },
      );
      const overlayBox = new PickerOverlay(title, list, {
        footer: "Enter select · ↑/↓ move · Esc cancel",
      });
      const overlay = tui.showOverlay(overlayBox, { width: "66%", anchor: "center" });
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
      // DOCKED HITL approval panel: replaces the composer at the bottom like
      // AskPanel so the user can see the exact tool command/diff/sandbox state
      // and respond with single keys (y / a / n / d) or arrows + Enter.
      const { promise, resolve } = Promise.withResolvers<ApprovalVerdict | null>();
      const panel = new ApprovalPanel(req, {
        onSettle: (verdict) => {
          undock(panel);
          resolve(verdict);
        },
        requestRender: () => tui.requestRender(),
      });
      dock(panel, () => {
        panel.dispose();
        undock(panel);
        resolve(null);
      });
      return promise;
    },
    askQuestions(input, opts) {
      const { promise, resolve } = Promise.withResolvers<AskQuestionResult | null>();
      const panel = new AskPanel(input, {
        onSettle: (result) => {
          undock(panel);
          resolve(result);
        },
        requestRender: () => tui.requestRender(),
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      dock(panel, () => {
        panel.dispose();
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
        emptyMessage: "  No messages to fork from",
      });
      const overlayBox = new PickerOverlay("Fork From Message", list, {
        titleRight: `${points.length} messages`,
        footer: "Enter fork · ↑/↓ move · Esc cancel",
      });
      const overlay = tui.showOverlay(overlayBox, { width: "72%", anchor: "center" });
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
      const items = layoutBranchTree(nodes)
        .slice(0, 200)
        .map(({ node: n, prefix }) => {
          const roleColor =
            n.role === "user"
              ? tuiTheme.accent
              : n.role === "assistant"
                ? tuiTheme.success
                : tuiTheme.dim;
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
        emptyMessage: "  No branch nodes",
      });
      const overlayBox = new PickerOverlay("Branch Tree", list, {
        titleRight: `${items.length} nodes`,
        footer: "Enter fork here · ↑/↓ move · PgUp/PgDn scroll · Esc close",
      });
      const overlay = tui.showOverlay(overlayBox, { width: "78%", anchor: "center" });
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
      const handle = tui.showOverlay(box, { width: "74%", anchor: "center" });
      return promise;
    },
    runPtyConsole(command, cwd, env, signal) {
      const ac = new AbortController();
      abortActivePty = () => ac.abort();
      signal?.addEventListener("abort", () => ac.abort(), { once: true });
      return runBashPtyConsole(tui, { command, cwd, env, signal: ac.signal }).finally(() => {
        abortActivePty = null;
      });
    },
    setHeader(info) {
      if (closed) return;
      shell.setHeader(
        info.model ?? "",
        info.sessionId ?? "",
        info.title ?? "",
        info.context,
        info.contextInfo,
      );
    },
    setInputText(text) {
      if (closed) return;
      editor.setText(text);
      safeRequestRender();
    },
    isFocused() {
      return focused;
    },
    notify() {
      if (closed) return;
      tui.terminal.write("\x07");
    },
    close() {
      if (closed) return;
      closed = true;
      docked?.dismiss();
      abortActivePty?.();
      defaultRegistry.removeCompletionListener(onRegistrySettled);
      clearInterval(elapsedTimer);
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
