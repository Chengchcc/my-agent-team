import {
  CachedOutputBlock,
  Card,
  type Component,
  type Container,
  type DefaultTextStyle,
  type FlexStatusSegment,
  type Loader,
  Markdown,
  type OutputBlockSection,
  renderFlexStatusBar,
  renderMeter,
  renderToolHeader,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  tuiTheme,
  visibleWidth,
  wrapTextWithAnsi,
} from "@chengchenccc/tui";
import { defaultRegistry } from "../../core/coordination/registry.js";
import type { OmaTranscriptContainer } from "./tui-components.js";
import {
  cleanHeaderTitle,
  contextColor,
  formatDurationMs,
  formatTokens,
  formatWorkspace,
  gitStatusCached,
  MARKDOWN_THEME,
  MAX_DIFF_LINES,
  prettyJson,
  refreshGitStatus,
  renderGitSegment,
  shimmerText,
  styleBashLine,
  summarizeResult,
  summarizeToolArgs,
} from "./tui-format.js";
import type { ContextUsageInfo, DriverKind } from "./tui-seam.js";
import {
  renderAskTool,
  renderHubTool,
  renderLearnTool,
  renderTaskTool,
} from "./tui-tool-render.js";
import { TuiTranscriptReconciler } from "./tui-transcript-reconciler.js";
import type { TranscriptItem, TuiViewState } from "./view-state.js";

/** Split text safely on CRLF / CR / LF so a stray carriage return inside a
 *  status or error message can never overwrite column 0 of the terminal. */
function splitSafeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function isEmptyOkResult(result: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(result);
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === "isError" && result.isError === false) return true;
  if (
    keys.every(
      (k) =>
        (k === "isError" && result.isError === false) ||
        (k === "ok" && result.ok === true) ||
        (k === "content" && typeof result.content === "string" && result.content.trim() === ""),
    )
  ) {
    return true;
  }
  return false;
}

/** Line-numbered, width-aware unified diff snippet for edit tool calls. */
function renderEditDiffLines(
  input: Readonly<Record<string, unknown>>,
  maxLines: number,
  maxWidth: number,
): string[] {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const oldLines = str(input.old_string) ? str(input.old_string).split("\n") : [];
  const newLines = str(input.new_string) ? str(input.new_string).split("\n") : [];
  const totalDigits = String(Math.max(oldLines.length, newLines.length, 1)).length;
  const contentBudget = Math.max(16, maxWidth - totalDigits - 4);
  const out: string[] = [];

  const shownOld = oldLines.slice(0, maxLines);
  for (let i = 0; i < shownOld.length; i++) {
    const ln = String(i + 1).padStart(totalDigits, " ");
    const text = truncateToWidth(shownOld[i] ?? "", contentBudget);
    out.push(`${tuiTheme.dim}${ln}\u001b[0m ${tuiTheme.error}- ${text}\u001b[0m`);
  }
  if (oldLines.length > maxLines) {
    out.push(`${tuiTheme.dim}  … (${oldLines.length - maxLines} more removed lines)\u001b[0m`);
  }

  const shownNew = newLines.slice(0, maxLines);
  for (let i = 0; i < shownNew.length; i++) {
    const ln = String(i + 1).padStart(totalDigits, " ");
    const text = truncateToWidth(shownNew[i] ?? "", contentBudget);
    out.push(`${tuiTheme.dim}${ln}\u001b[0m ${tuiTheme.success}+ ${text}\u001b[0m`);
  }
  if (newLines.length > maxLines) {
    out.push(`${tuiTheme.dim}  … (${newLines.length - maxLines} more added lines)\u001b[0m`);
  }
  return out;
}

/** Renders transcript items to display lines, memoizing markdown/tool blocks.
 *  Extracted from tui-io.ts to keep the io assembly file under 500 lines. */
export class TuiItemRenderer {
  private readonly markdownCache = new WeakMap<TranscriptItem, Markdown>();
  /** Items seen while streaming: their first settled render must use a
   *  FRESH Markdown instance. The streaming instance carries frozen-prefix
   *  state whose output can differ from a cold render of the final text;
   *  settled rows commit to scrollback immutably, so the settle frame has
   *  to be the canonical render (what /resume replays). */
  private readonly streamedItems = new WeakSet<TranscriptItem>();
  private readonly itemLineCache = new WeakMap<
    TranscriptItem,
    { lines: string[]; showThinking: boolean; showToolDetail: boolean; width: number }
  >();
  private readonly toolBlockCache = new WeakMap<TranscriptItem, CachedOutputBlock>();

  constructor(private readonly tui: TUI) {}

  renderItem(item: TranscriptItem, state: TuiViewState): string[] {
    const cached = this.itemLineCache.get(item);
    if (
      cached &&
      !item.streaming &&
      cached.showThinking === state.showThinking &&
      cached.showToolDetail === state.showToolDetail &&
      cached.width === this.tui.terminal.columns
    ) {
      return cached.lines;
    }
    const lines = this.computeRenderItem(item, state);
    if (!item.streaming) {
      this.itemLineCache.set(item, {
        lines,
        showThinking: state.showThinking,
        showToolDetail: state.showToolDetail,
        width: this.tui.terminal.columns,
      });
    }
    return lines;
  }

  private computeRenderItem(item: TranscriptItem, state: TuiViewState): string[] {
    switch (item.kind) {
      case "user":
        if (!item.text) return [];
        if (item.pending) {
          return [`${tuiTheme.dim}  » ${item.text.replace(/\r?\n/g, " ↵ ")}\u001b[0m`];
        }
        return this.renderUserMessage(item.text);
      case "assistant": {
        const lines: string[] = [];
        if (item.thinking) lines.push(...this.renderThinking(item.thinking, state.showThinking));
        if (item.text) lines.push(...this.markdownLines(item, 1, 0));
        return lines;
      }
      case "thinking":
        return this.renderThinking(item.text, state.showThinking);
      case "tool":
        return this.renderTool(item, state.showToolDetail);
      case "status":
        return this.renderStatus(item.text, item.streaming);
      case "error":
        return this.renderError(item.text);
    }
  }

  /** Compact terminal-native user prompt: bold `❯ ` gutter without wasting
   *  3 rows on a heavy dark panel box. */
  private renderUserMessage(text: string): string[] {
    const cols = Math.max(20, this.tui.terminal.columns);
    const wrapped = wrapTextWithAnsi(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), cols - 4);
    return wrapped.map((line, idx) =>
      idx === 0
        ? ` ${tuiTheme.accent}\u001b[1m❯\u001b[0m \u001b[1m${line}\u001b[0m`
        : `   \u001b[1m${line}\u001b[0m`,
    );
  }

  private renderStatus(text: string, streaming: boolean): string[] {
    if (!text.trim()) return [];
    const rawLines = splitSafeLines(text);
    if (streaming) {
      return rawLines.map((line) => `  · ${shimmerText(line)}`);
    }
    if (rawLines.length === 1) {
      return [`${tuiTheme.dim}  · ${rawLines[0] ?? ""}\u001b[0m`];
    }
    return rawLines.map((line) => {
      if (!line.trim()) return "";
      if (line.startsWith("[") && line.endsWith("]")) {
        return `  ${tuiTheme.accent}\u001b[1m${line}\u001b[0m`;
      }
      if (line === "SHORTCUTS") {
        return `  ${tuiTheme.accent}\u001b[1m${line}\u001b[0m`;
      }
      return `${tuiTheme.dim}  ${line}\u001b[0m`;
    });
  }

  private renderError(text: string): string[] {
    const rawLines = splitSafeLines(text);
    return rawLines.map((line, idx) =>
      idx === 0
        ? `${tuiTheme.error}  ✘ error: ${line}\u001b[0m`
        : `${tuiTheme.error}    ${line}\u001b[0m`,
    );
  }

  private markdownLines(
    item: TranscriptItem,
    paddingX: number,
    paddingY: number,
    style?: DefaultTextStyle,
  ): string[] {
    if (item.streaming) {
      this.streamedItems.add(item);
    } else if (this.streamedItems.has(item)) {
      // Settle transition: force the cold render (see streamedItems doc).
      this.streamedItems.delete(item);
      this.markdownCache.delete(item);
    }
    let md = this.markdownCache.get(item);
    if (!md) {
      md = new Markdown(item.text, paddingX, paddingY, MARKDOWN_THEME, style);
      this.markdownCache.set(item, md);
    } else {
      md.setText(item.text);
    }
    return md.render(this.tui.terminal.columns);
  }

  private renderThinking(text: string, expanded: boolean): string[] {
    if (!text) return [];
    const firstLine = text.split("\n", 1)[0] ?? "";
    const dim = (s: string): string => `${tuiTheme.dim}${s}\u001b[0m`;
    if (!expanded) {
      if (text.length === firstLine.length) return [dim(`  ~ ${firstLine}`)];
      return [dim(`  ~ ${firstLine} … (ctrl+t)`)];
    }
    const wrapWidth = Math.max(20, this.tui.terminal.columns - 6);
    return wrapTextWithAnsi(text, wrapWidth).map((line) => dim(`  ~ ${line}`));
  }

  private renderTool(item: TranscriptItem, expanded: boolean): string[] {
    const toolName = item.text.replace(/…$/, "");
    // Todo renders chrome-only (pinned snapshot above the editor): the
    // transcript stays quiet — the loader's activity summary already
    // surfaces the running todo_write call.
    if (toolName === "todo" || toolName === "todo_read" || toolName === "todo_write") {
      return [];
    }
    if (toolName === "task") {
      return renderTaskTool(item, expanded, this.tui.terminal.columns);
    }
    if (toolName === "hub") {
      return renderHubTool(item, expanded, this.tui.terminal.columns);
    }
    if (toolName === "learn") {
      return renderLearnTool(item, expanded);
    }
    if (toolName === "ask_question") {
      return renderAskTool(item, expanded, this.tui.terminal.columns);
    }
    const failed =
      item.result !== undefined &&
      (item.result.isError === true || item.result.error !== undefined);
    const running = item.streaming;
    const mark = running ? "\u27f3" : failed ? "\u2718" : "\u2714";
    const state = running ? "running" : failed ? "error" : "success";
    const titleColor =
      state === "running"
        ? tuiTheme.warning
        : state === "error"
          ? tuiTheme.error
          : tuiTheme.success;
    const wallMs =
      item.durationMs ??
      (item.streaming && item.startedAt !== undefined ? Date.now() - item.startedAt : undefined);
    const wallLabel = wallMs !== undefined ? formatDurationMs(wallMs) : "";
    const cols = Math.max(24, this.tui.terminal.columns);

    if (!expanded) {
      return this.renderToolCompact(item, {
        toolName,
        failed,
        running,
        mark,
        titleColor,
        wallLabel,
        cols,
      });
    }

    const metaParts: string[] = [];
    if (wallLabel) metaParts.push(wallLabel);
    if (running && item.timeoutMs !== undefined) {
      metaParts.push(`timeout ${Math.round(item.timeoutMs / 1000)}s`);
    }
    const header = renderToolHeader({
      icon: mark,
      title: toolName,
      ...(metaParts.length > 0 ? { meta: metaParts } : {}),
      titleColor,
    });

    const sections: OutputBlockSection[] = [];

    if (item.input !== undefined) {
      const lines: string[] = [];
      for (const line of prettyJson(item.input).split("\n")) {
        lines.push(`${tuiTheme.dim}${line}\u001b[0m`);
      }
      sections.push({ label: "Input", lines });
    }

    if (toolName === "edit" && item.input !== undefined) {
      const diffLines = renderEditDiffLines(item.input, MAX_DIFF_LINES * 2, cols - 6);
      if (diffLines.length > 0) sections.push({ label: "Diff", lines: diffLines });
    }

    if (item.output && item.streaming) {
      const tail = item.output.slice(-600);
      const lines: string[] = [];
      for (const line of tail.split("\n").slice(-6)) {
        if (line.trim()) lines.push(`${tuiTheme.dim}${line}\u001b[0m`);
      }
      if (lines.length > 0) sections.push({ lines });
    }

    if (item.result !== undefined && !isEmptyOkResult(item.result)) {
      const content = typeof item.result.content === "string" ? item.result.content : null;
      const resultColor = failed ? tuiTheme.error : tuiTheme.dim;
      const lines: string[] = [];
      if (content !== null) {
        let textContent = content.trimEnd();
        const trimmed = textContent.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            textContent = prettyJson(JSON.parse(textContent));
          } catch {
            // keep raw text
          }
        }
        const outputLines = textContent
          .split("\n")
          .filter((line) => !(!failed && /\[exit: \d+\]/.test(line)));
        const maxOut = 16;
        const display = outputLines.slice(0, maxOut);
        const isCodeResult = toolName === "read" || toolName === "write";
        for (const line of display) {
          const truncated = truncateToWidth(line, cols - 6);
          lines.push(
            isCodeResult && !failed
              ? MARKDOWN_THEME.codeBlock(truncated)
              : `${resultColor}${truncated}\u001b[0m`,
          );
        }
        if (outputLines.length > maxOut) {
          lines.push(`${tuiTheme.dim}… ${outputLines.length - maxOut} more lines\u001b[0m`);
        }
      } else {
        const summary = summarizeResult(item.result);
        if (summary) lines.push(`${resultColor}${summary}\u001b[0m`);
      }
      if (lines.length > 0) {
        sections.push({ label: "Output", lines });
      }
    }

    let block = this.toolBlockCache.get(item);
    if (!block) {
      block = new CachedOutputBlock();
      this.toolBlockCache.set(item, block);
    }
    return [
      ...block.render({
        header,
        state,
        sections,
        width: cols,
        bg: (line: string) => `${tuiTheme.bgPanel}${line}\u001b[0m`,
      }),
    ];
  }

  /** Lightweight Gutter/Tree collapsed tool view: 1 header line + slim `│`
   *  body rows (no full-width heavy box per tool call). Preserves verdict
   *  color token (`warning` / `error` / `success`) on row 0. */
  private renderToolCompact(
    item: TranscriptItem,
    opts: {
      toolName: string;
      failed: boolean;
      running: boolean;
      mark: string;
      titleColor: string;
      wallLabel: string;
      cols: number;
    },
  ): string[] {
    const { toolName, failed, running, mark, titleColor, wallLabel, cols } = opts;
    const gutter = `${tuiTheme.faint}  │ \u001b[0m`;
    const bodyWidth = Math.max(16, cols - 5);

    // Format primary inline summary right next to tool name
    let argInline = "";
    const extraInputLines: string[] = [];
    if (item.input !== undefined) {
      if (toolName === "bash" && typeof item.input.command === "string") {
        const cmdLines = item.input.command.split("\n");
        argInline = `${tuiTheme.dim}$ \u001b[0m${styleBashLine(cmdLines[0] ?? "")}`;
        for (const extra of cmdLines.slice(1, 3)) {
          extraInputLines.push(`  ${styleBashLine(truncateToWidth(extra, bodyWidth - 2))}`);
        }
        if (cmdLines.length > 3) {
          extraInputLines.push(`${tuiTheme.dim}  … +${cmdLines.length - 3} lines\u001b[0m`);
        }
      } else {
        const summary = summarizeToolArgs(toolName, item.input);
        if (summary) argInline = `${tuiTheme.dim}${summary}\u001b[0m`;
      }
    }

    const rightMetaParts: string[] = [];
    if (wallLabel) rightMetaParts.push(wallLabel);
    if (running && item.timeoutMs !== undefined) {
      rightMetaParts.push(`≤${Math.round(item.timeoutMs / 1000)}s`);
    }
    const rightMeta =
      rightMetaParts.length > 0 ? `${tuiTheme.dim}${rightMetaParts.join(" · ")}\u001b[0m` : "";
    const rightMetaW = visibleWidth(rightMeta);

    const headLead = ` ${titleColor}${mark} \u001b[1m${toolName}\u001b[22m\u001b[0m`;
    const leadW = visibleWidth(headLead);
    const argBudget = Math.max(0, cols - leadW - (rightMetaW > 0 ? rightMetaW + 2 : 0) - 2);
    const clippedArg =
      argInline && argBudget > 4 ? ` ${truncateToWidth(argInline, argBudget)}` : "";
    const leftHead = `${headLead}${clippedArg}`;
    const gap = Math.max(1, cols - visibleWidth(leftHead) - rightMetaW - 1);
    const headerLine =
      rightMetaW > 0 && visibleWidth(leftHead) + 1 + rightMetaW < cols
        ? `${leftHead}${" ".repeat(gap)}${rightMeta}`
        : truncateToWidth(leftHead, cols);

    const rows: string[] = [headerLine];
    for (const extra of extraInputLines) {
      rows.push(`${gutter}${extra}`);
    }

    if (toolName === "edit" && item.input !== undefined) {
      for (const diffLine of renderEditDiffLines(item.input, MAX_DIFF_LINES, bodyWidth)) {
        rows.push(`${gutter}${diffLine}`);
      }
    }

    if (item.output && running) {
      const tail = item.output.slice(-600);
      for (const line of tail.split("\n").slice(-4)) {
        if (line.trim()) {
          rows.push(`${gutter}${tuiTheme.dim}${truncateToWidth(line, bodyWidth)}\u001b[0m`);
        }
      }
    }

    if (item.result !== undefined && !isEmptyOkResult(item.result)) {
      const content = typeof item.result.content === "string" ? item.result.content : null;
      const resultColor = failed ? tuiTheme.error : tuiTheme.dim;
      if (content !== null) {
        let textContent = content.trimEnd();
        const trimmed = textContent.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            textContent = prettyJson(JSON.parse(textContent));
          } catch {
            // keep raw text
          }
        }
        const outputLines = textContent
          .split("\n")
          .filter((line) => !(!failed && /\[exit: \d+\]/.test(line)))
          .filter((line, _idx, arr) => !(arr.length === 1 && line.trim() === ""));
        const maxOut = 4;
        const display = outputLines.slice(0, maxOut);
        const isCodeResult = toolName === "read" || toolName === "write";
        for (const line of display) {
          const truncated = truncateToWidth(line, bodyWidth);
          rows.push(
            `${gutter}${
              isCodeResult && !failed
                ? MARKDOWN_THEME.codeBlock(truncated)
                : `${resultColor}${truncated}\u001b[0m`
            }`,
          );
        }
        if (outputLines.length > maxOut) {
          rows.push(
            `${tuiTheme.faint}  ╰ \u001b[0m${tuiTheme.dim}… ${outputLines.length - maxOut} more lines (ctrl+o)\u001b[0m`,
          );
        }
      } else {
        const summary = summarizeResult(item.result);
        if (summary) {
          rows.push(`${gutter}${resultColor}${truncateToWidth(summary, bodyWidth)}\u001b[0m`);
        }
      }
    }

    return rows;
  }
}

/** Header/status/transcript render shell for createTerminalIo. Owns the
 *  display-only mutable state (header fields, busy, status line) so the io
 *  assembly file stays small. */
export class TuiRenderShell {
  private headerInfo = "oma";
  private headerModel = "";
  private headerSession = "";
  private headerTitle = "";
  private headerContext = "";
  private headerContextInfo?: ContextUsageInfo;
  private busy = false;
  private loader: Loader | null = null;
  private busySeconds = 0;
  private currentState: TuiViewState | null = null;
  private lastStatusKey = "";
  get viewState(): TuiViewState | null {
    return this.currentState;
  }
  statusLineText = "";
  /** Driver indicators (one per turn driver): each is a label the driver
   *  composes, so a fourth driver adds a row here rather than another field,
   *  setter and render branch. */
  private readonly driverStatus = new Map<DriverKind, string>();
  setDriverStatus(kind: DriverKind, text: string | undefined): void {
    const next = text ?? "";
    if ((this.driverStatus.get(kind) ?? "") === next) return;
    if (next === "") this.driverStatus.delete(kind);
    else this.driverStatus.set(kind, next);
    this.addStatusBar(true);
    this.tui.requestRender();
  }

  /** Mode-semantic accent color for the composer prompt and top border. */
  activeModeAccent(): string {
    if (this.driverStatus.has("plan")) return tuiTheme.info;
    if (this.driverStatus.has("goal")) return tuiTheme.warning;
    if (this.driverStatus.has("loop")) return tuiTheme.success;
    return tuiTheme.accent;
  }

  /** Undelivered steers (omp pending-messages): surfaced in the busy
   *  loader as the "enter sends now" affordance. */
  private queuedCount = 0;
  private readonly itemRenderer: TuiItemRenderer;
  private readonly reconciler: TuiTranscriptReconciler;
  lastLiveStartRow = 0;
  lastTotalRows = 0;
  /** CC-style rotating gerunds for the busy loader (no tool intent). */
  private static readonly WORKING_WORDS: readonly string[] = [
    "thinking",
    "pondering",
    "brewing",
    "conjuring",
    "scheming",
    "reasoning",
    "vibing",
    "cooking",
  ];
  /** Coalescing window for live-run renders (see render()). */
  private static readonly RENDER_COALESCE_MS = 50;
  private lastRenderWorkAt = 0;
  private latestState: TuiViewState | null = null;
  private coalescedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Session id the header block was last printed for (cc-style: the
   *  banner scrolls away with the transcript and re-prints per session). */
  private lastPrintedSession: string | null = null;
  /** The card's own children, so a session change can drop the previous one:
   *  the header is chrome, and chrome must exist exactly once. */
  private headerChildren: Component[] = [];
  private welcomeTipShown = false;

  constructor(
    private readonly tui: TUI,
    private readonly transcript: OmaTranscriptContainer,
    private readonly statusContainer: Container,
    private readonly workspaceRoot: string,
    private readonly welcomeTip: string,
  ) {
    this.itemRenderer = new TuiItemRenderer(tui);
    // A reset clears the whole container, header card included — and the
    // header is not a reconciled group, so nothing would bring it back. That
    // is what /new looked like: a wiped transcript with no header, and
    // lastPrintedSession already advanced so it never re-printed.
    this.reconciler = new TuiTranscriptReconciler((transcript) => {
      if (this.lastPrintedSession !== null) this.appendHeaderCard(transcript);
    });
  }

  setBusy(busy: boolean, loader: Loader | null, busySeconds: number): void {
    // A settle must land the final state immediately, not wait for the
    // coalescing window.
    if (!busy && this.busy) this.flushPendingRender();
    this.busy = busy;
    this.loader = loader;
    this.busySeconds = busySeconds;
    if (!busy) {
      void refreshGitStatus(this.workspaceRoot);
      this.addStatusBar(true);
    }
  }

  /** Whether the loader is ticking — i.e. a repaint clock exists. Chrome
   *  that samples paint time (the todo sweep) must animate only under this,
   *  or it freezes mid-band on an idle-but-seeded surface (post-resume). */
  get animating(): boolean {
    return this.busy;
  }

  setBusySeconds(busySeconds: number): void {
    this.busySeconds = busySeconds;
  }

  setQueuedCount(count: number): void {
    this.queuedCount = count;
    this.updateWorkingMessage();
  }

  setCurrentState(state: TuiViewState): void {
    this.currentState = state;
  }

  setHeader(
    model: string,
    session: string,
    title: string,
    context?: string,
    contextInfo?: ContextUsageInfo | null,
  ): void {
    const prevModel = this.headerModel;
    this.headerModel = model;
    this.headerSession = session;
    this.headerTitle = title;
    if (context !== undefined) this.headerContext = context;
    if (contextInfo === null) this.headerContextInfo = undefined;
    else if (contextInfo !== undefined) this.headerContextInfo = contextInfo;
    const coldModelResolved =
      !prevModel && Boolean(model) && (!this.currentState || this.currentState.runs.length === 0);
    if (coldModelResolved && this.lastPrintedSession === this.headerSession) {
      this.appendHeaderCard(this.transcript);
    } else {
      this.renderHeader();
    }
    void refreshGitStatus(this.workspaceRoot);
    if (!this.busy) {
      this.statusContainer.clear();
      this.addStatusBar(true);
    } else {
      this.addStatusBar(true);
    }
    this.tui.requestRender();
  }

  /** Print the header INTO the transcript: it scrolls away with content
   *  (cc-style) instead of pinning as live chrome. Re-prints only when the
   *  session identity changes — model/context stay visible in the status
   *  bar. */
  renderHeader(): void {
    if (this.lastPrintedSession !== null && this.headerSession === this.lastPrintedSession) {
      return;
    }
    this.appendHeaderCard(this.transcript);
    this.lastPrintedSession = this.headerSession;
  }

  /** Emit the header card into a transcript, replacing any card already
   *  there. Split out of renderHeader() so a reconcile reset can re-emit the
   *  SAME bytes without touching the session-change gate. */
  private appendHeaderCard(into: OmaTranscriptContainer): void {
    const insertAt = this.removeHeaderCard(into);
    const cols = Math.max(24, this.tui.terminal.columns);
    const infoLines: string[] = [];
    infoLines.push(`\u001b[1m  ${this.headerInfo}\u001b[0m`);
    const hTitle = cleanHeaderTitle(this.headerTitle);
    if (hTitle) infoLines.push(`${tuiTheme.dim}  ${hTitle}\u001b[0m`);
    if (this.headerModel) {
      infoLines.push(
        `${tuiTheme.dim}  model:\u001b[0m ${tuiTheme.accent}${this.headerModel}\u001b[0m`,
      );
    }
    infoLines.push(
      `${tuiTheme.dim}  workspace:\u001b[0m ${tuiTheme.info}${formatWorkspace(this.workspaceRoot)}\u001b[0m`,
    );
    const hGit = gitStatusCached(this.workspaceRoot);
    if (hGit) infoLines.push(`${tuiTheme.dim}  git:\u001b[0m ${renderGitSegment(hGit)}`);
    if (this.headerSession)
      infoLines.push(`${tuiTheme.dim}  session:\u001b[0m ${this.headerSession.slice(0, 8)}`);
    if (this.headerContext)
      infoLines.push(`${tuiTheme.dim}  context:\u001b[0m ${this.headerContext}`);

    // Hide the 31-col ASCII banner on narrow (< 72 cols) terminals so the
    // metadata lines remain fully readable without clipping.
    const combined: string[] = [];
    if (cols >= 72) {
      const banner = [
        `${tuiTheme.accent}  ██████╗ ███╗   ███╗ █████╗ \u001b[0m`,
        `${tuiTheme.accent} ██╔═══██╗████╗ ████║██╔══██╗\u001b[0m`,
        `${tuiTheme.accent} ██║   ██║██╔████╔██║███████║\u001b[0m`,
        `${tuiTheme.accent} ██║   ██║██║╚██╔╝██║██╔══██║\u001b[0m`,
        `${tuiTheme.accent} ╚██████╔╝██║ ╚═╝ ██║██║  ██║\u001b[0m`,
        `${tuiTheme.accent}  ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝\u001b[0m`,
      ];
      const rows = Math.max(banner.length, infoLines.length);
      for (let i = 0; i < rows; i++) {
        const left = banner[i] ?? "";
        const right = infoLines[i] ?? "";
        combined.push(`${left}${left ? "   " : ""}${right}`);
      }
    } else {
      combined.push(...infoLines);
    }
    const headerCard = new Card(
      combined.map((line) => new Text(truncateToWidth(line, cols - 2), 0, 0)),
      {
        paddingX: 0,
        paddingY: 0,
        border: { color: (s: string) => `${tuiTheme.dim}${s}\u001b[0m` },
      },
    );
    const fresh: Component[] = [];
    for (const line of headerCard.render(cols)) {
      fresh.push(new Text(truncateToWidth(line, cols), 0, 0));
    }
    if (insertAt !== -1 && insertAt <= into.children.length) {
      into.children.splice(insertAt, 0, ...fresh);
    } else {
      for (const child of fresh) into.addChild(child);
    }
    this.headerChildren = fresh;
  }

  /** Drop the previous card and return its former start index (-1 if absent). */
  private removeHeaderCard(from: OmaTranscriptContainer): number {
    const children = this.headerChildren;
    this.headerChildren = [];
    const first = children[0];
    if (!first) return -1;
    const start = from.children.indexOf(first);
    if (start === -1) return -1;
    from.children.splice(start, children.length);
    return start;
  }

  currentActivitySummary(): string | undefined {
    if (!this.currentState) return undefined;
    for (let r = this.currentState.runs.length - 1; r >= 0; r--) {
      const run = this.currentState.runs[r]!;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]!;
        if (item.kind === "tool" && item.streaming) {
          const name = item.text.replace(/…$/, "");
          const intent =
            typeof item.input?.intent === "string"
              ? item.input.intent.trim()
              : typeof item.input?.description === "string"
                ? item.input.description.trim()
                : "";
          const summary = intent
            ? intent
            : item.input !== undefined
              ? summarizeToolArgs(name, item.input)
              : "";
          return summary.trim() ? `${name} · ${summary}` : name;
        }
      }
    }
    for (let r = this.currentState.runs.length - 1; r >= 0; r--) {
      const run = this.currentState.runs[r]!;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]!;
        if (item.kind === "tool" && item.text) return item.text.replace(/…$/, "");
      }
    }
    return undefined;
  }

  updateWorkingMessage(): void {
    if (!this.busy || !this.loader) return;
    const summary = this.currentActivitySummary();
    const seconds = this.busySeconds > 0 ? ` · ${this.busySeconds}s` : "";
    const label =
      summary ??
      `${
        TuiRenderShell.WORKING_WORDS[
          Math.floor(this.busySeconds / 3) % TuiRenderShell.WORKING_WORDS.length
        ]
      }…`;
    const queued = this.queuedCount > 0 ? ` · ${this.queuedCount} queued — enter sends now` : "";
    const long =
      this.busySeconds >= 30 ? " · long-running — esc aborts; prompts need pty:true" : "";
    this.loader.setMessage(`${label}${seconds}${queued}${long} (esc to abort)`);
  }

  /** Responsive two-column status bar rendered directly at the live terminal
   *  width so critical indicators (mode, model, ctx%) survive 60–80 cols. */
  renderStatusBarLine(width: number): string {
    const git = gitStatusCached(this.workspaceRoot);
    const runningBg = defaultRegistry.countRunningJobs();
    const left: FlexStatusSegment[] = [];
    const right: FlexStatusSegment[] = [];

    for (const kind of ["plan", "goal", "loop"] as const) {
      const text = this.driverStatus.get(kind);
      if (text) {
        const fg =
          kind === "plan" ? tuiTheme.info : kind === "goal" ? tuiTheme.warning : tuiTheme.success;
        left.push({ text, chip: true, bg: tuiTheme.bgOverlay, fg, priority: 1 });
      }
    }
    if (this.headerModel) {
      left.push({
        text: this.headerModel,
        chip: true,
        bg: tuiTheme.bgOverlay,
        fg: tuiTheme.accent,
        priority: 2,
      });
    }
    if (runningBg > 0) {
      left.push({
        text: `⏵ ${runningBg} bg`,
        chip: true,
        bg: tuiTheme.bgChipOk,
        fg: tuiTheme.success,
        priority: 3,
      });
    }
    left.push({
      text: formatWorkspace(this.workspaceRoot, width < 80 ? 18 : 28),
      fg: tuiTheme.info,
      priority: 5,
    });
    if (git) {
      left.push({ text: renderGitSegment(git), priority: 6 });
    }

    if (this.headerContextInfo && this.headerContextInfo.limit > 0) {
      right.push({ text: renderMeter(this.headerContextInfo.pct, 6), priority: 2 });
      right.push({
        text: `${formatTokens(this.headerContextInfo.estimatedTokens)}/${formatTokens(this.headerContextInfo.limit)}`,
        fg: tuiTheme.dim,
        priority: 4,
      });
      if (this.headerContextInfo.usageSummary) {
        right.push({
          text: this.headerContextInfo.usageSummary,
          fg: tuiTheme.dim,
          priority: 3,
        });
      }
    } else if (this.headerContext) {
      right.push({
        text: this.headerContext,
        fg: contextColor(this.headerContext),
        priority: 2,
      });
    }
    if (this.headerSession) {
      right.push({ text: this.headerSession.slice(0, 8), fg: tuiTheme.dim, priority: 7 });
    }

    return renderFlexStatusBar({ left, right, width });
  }

  addStatusBar(force = false): void {
    const git = gitStatusCached(this.workspaceRoot);
    const runningBg = defaultRegistry.countRunningJobs();
    const drivers = [
      this.driverStatus.get("plan") ?? "",
      this.driverStatus.get("goal") ?? "",
      this.driverStatus.get("loop") ?? "",
    ].join("|");
    const width = Math.max(40, this.tui.terminal.columns);
    const key = `${width}|${this.headerModel}|${this.headerSession}|${this.headerContext}|${this.headerContextInfo?.estimatedTokens ?? ""}|${this.headerContextInfo?.pct ?? ""}|${this.headerContextInfo?.usageSummary ?? ""}|${git}|${runningBg}|${drivers}`;
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.statusLineText = this.renderStatusBarLine(width);
  }

  /** Background job settlement (M-bash/M-eval): append a visible block
   *  with the exit state and output tail. Native scrollback is
   *  append-only, so this lands as a new transcript block rather than
   *  rewriting the original "Backgrounded as job …" line. Accepts one
   *  line or pre-styled rows. */
  appendNotice(lines: string | readonly string[]): void {
    const rows =
      typeof lines === "string" ? [`${tuiTheme.accent}  \u23f5 ${lines}\u001b[0m`] : lines;
    if (rows.length === 0) return;
    for (const line of rows) this.transcript.addChild(new Text(line, 0, 0));
    this.tui.requestRender();
  }

  renderIdleFooter(): void {
    this.addStatusBar();
  }

  render(state: TuiViewState): void {
    this.latestState = state;
    const now = Date.now();
    if (this.busy && now - this.lastRenderWorkAt < TuiRenderShell.RENDER_COALESCE_MS) {
      this.scheduleCoalescedRender(now);
      return;
    }
    this.renderNow(state);
  }

  /** One pending coalesced render at a time; it fires with the LATEST state. */
  private scheduleCoalescedRender(now: number): void {
    if (this.coalescedTimer !== undefined) return;
    const wait = Math.max(1, TuiRenderShell.RENDER_COALESCE_MS - (now - this.lastRenderWorkAt));
    this.coalescedTimer = setTimeout(() => {
      this.coalescedTimer = undefined;
      const state = this.latestState;
      if (state) this.renderNow(state);
    }, wait);
  }

  /** Flush a pending coalesced render immediately (settle / quit). */
  flushPendingRender(): void {
    if (this.coalescedTimer !== undefined) {
      clearTimeout(this.coalescedTimer);
      this.coalescedTimer = undefined;
    }
    if (this.latestState) this.renderNow(this.latestState);
  }

  /** Rebuild transcript children at the current terminal width before a
   *  resize history replay. Without this, `beginHistoryReplay` replays lines
   *  pre-wrapped at the OLD width, and the next streaming frame re-wraps
   *  every settled item in-place behind `committedRows`, shifting the
   *  scrollback frontier out of alignment. */
  rewrapForResize(): void {
    const state = this.currentState;
    if (!state) return;
    this.reconciler.reset(this.transcript);
    const result = this.reconciler.reconcile(this.transcript, state.runs, state, (item) =>
      this.itemRenderer.renderItem(item, state),
    );
    this.lastLiveStartRow = result.liveStartRow;
    this.lastTotalRows = result.totalRows;
    this.addStatusBar(true);
  }

  private renderNow(state: TuiViewState): void {
    this.setCurrentState(state);
    // Streaming blocks (including mermaid) are already kept out of scrollback
    // by `fitTailBoundary(..., liveStartRow)`; never freeze the entire settled
    // prefix via `setDeferCommit(true)`, which previously prevented settled
    // history from entering scrollback and dropped replay on resize.
    this.transcript.setDeferCommit(false);
    if (this.busy) this.updateWorkingMessage();
    const result = this.reconciler.reconcile(this.transcript, state.runs, state, (item) =>
      this.itemRenderer.renderItem(item, state),
    );
    this.lastLiveStartRow = result.liveStartRow;
    this.lastTotalRows = result.totalRows;
    if (!this.welcomeTipShown && this.welcomeTip) {
      this.welcomeTipShown = true;
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(new Text(`${tuiTheme.warning}  ${this.welcomeTip}\u001b[0m`, 0, 0));
      this.transcript.addChild(new Spacer(1));
    }
    // Memoized: only rebuilds when inputs actually changed (zero git spawn /
    // zero string churn on 50ms streaming chunks).
    this.addStatusBar();
    this.tui.requestRender(result.didReset);
    this.lastRenderWorkAt = Date.now();
  }
}
