import {
  Container,
  type FramePlan,
  Input,
  matchesKey,
  type NativeScrollbackCommittedRows,
  type NativeScrollbackLiveRegion,
  type NativeScrollbackReplay,
  type RenderStablePrefix,
  renderModalFrame,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type TerminalFrameProvider,
  type Text,
  tuiTheme,
} from "@chengchenccc/tui";

export interface PickerOverlayOptions {
  title?: string;
  titleRight?: string;
  footer?: string;
}

export class PickerOverlay extends Container {
  private readonly titleText?: Text;
  private readonly modalOpts: PickerOverlayOptions;

  constructor(
    title: Text | string,
    private readonly list: SelectList,
    opts: PickerOverlayOptions = {},
  ) {
    super();
    if (typeof title === "string") {
      this.modalOpts = { title, ...opts };
    } else {
      this.titleText = title;
      this.modalOpts = opts;
    }
    this.addChild(list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const titleStr = this.modalOpts.title ?? this.titleText?.render(innerWidth)[0]?.trim();
    const listLines = this.list.render(innerWidth);
    return renderModalFrame({
      ...(titleStr ? { title: titleStr } : {}),
      ...(this.modalOpts.titleRight ? { titleRight: this.modalOpts.titleRight } : {}),
      ...(this.modalOpts.footer ? { footer: this.modalOpts.footer } : {}),
      lines: listLines,
      width,
    });
  }
}

export interface FilterablePickerOptions {
  title: string;
  placeholder?: string;
  footer?: string;
  maxVisible?: number;
  emptyMessage?: string;
  layout?: SelectListLayoutOptions;
  theme: SelectListTheme;
  items: readonly SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
  onDelete?: (item: SelectItem) => boolean | string | undefined;
}

/** Unified terminal-native filterable modal picker: ModalFrame + live filter
 *  Input + SelectList with scrollbar, PgUp/PgDn/Home/End, and optional Ctrl+D
 *  delete. Used by /resume, /model (Ctrl+P), and Ctrl+R history search. */
export class FilterablePickerOverlay extends Container {
  private readonly query = new Input();
  private list: SelectList;
  private allItems: SelectItem[];
  private statusNote = "";
  private readonly opts: FilterablePickerOptions;

  constructor(opts: FilterablePickerOptions) {
    super();
    this.opts = opts;
    this.allItems = [...opts.items];
    this.list = this.buildList();
  }

  setItems(items: readonly SelectItem[]): void {
    this.allItems = [...items];
    this.list = this.buildList();
  }

  setStatusNote(note: string): void {
    this.statusNote = note;
  }

  private filteredItems(): SelectItem[] {
    const needle = this.query.getValue().trim().toLowerCase();
    if (!needle) return this.allItems;
    return this.allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.value.toLowerCase().includes(needle) ||
        (item.description?.toLowerCase().includes(needle) ?? false),
    );
  }

  private buildList(): SelectList {
    const matches = this.filteredItems().slice(0, 200);
    const list = new SelectList(matches, this.opts.maxVisible ?? 10, this.opts.theme, {
      emptyMessage: this.opts.emptyMessage ?? "  No matches",
      ...this.opts.layout,
    });
    list.onSelect = (item) => this.opts.onSelect(item);
    list.onCancel = () => this.opts.onCancel();
    if (this.opts.onDelete) {
      const del = this.opts.onDelete;
      list.onDelete = (item) => {
        const idx = this.list.getSelectedIndex();
        const res = del(item);
        if (typeof res === "string") {
          this.statusNote = res;
        } else if (res === true) {
          this.statusNote = "";
          this.allItems = this.allItems.filter((x) => x.value !== item.value);
          this.list = this.buildList();
          this.list.setSelectedIndex(idx);
        }
      };
    }
    return list;
  }

  handleInput(data: string): void {
    const navigates =
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "enter") ||
      (this.opts.onDelete !== undefined && matchesKey(data, "ctrl+d"));
    if (navigates) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.opts.onCancel();
      return;
    }
    this.statusNote = "";
    this.query.handleInput(data);
    this.list = this.buildList();
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const filtered = this.filteredItems();
    const countLabel =
      this.query.getValue().trim().length > 0
        ? `${filtered.length}/${this.allItems.length}`
        : `${this.allItems.length}`;
    const filterValue = this.query.getValue();
    const queryLine = filterValue
      ? `${tuiTheme.accent}› \u001b[0m${this.query.render(Math.max(1, innerWidth - 2))[0] ?? ""}`
      : `${tuiTheme.accent}› \u001b[0m${tuiTheme.dim}${this.opts.placeholder ?? "Type to filter…"}\u001b[0m`;
    const bodyLines: string[] = [queryLine, "---"];
    if (this.statusNote) {
      bodyLines.push(`${tuiTheme.warning}${this.statusNote}\u001b[0m`);
    }
    bodyLines.push(...this.list.render(innerWidth));
    return renderModalFrame({
      title: this.opts.title,
      titleRight: countLabel,
      footer: this.opts.footer ?? "Enter select · ↑/↓ move · Esc close",
      lines: bodyLines,
      width,
    });
  }
}

/** Overlay for ctrl+r history search: delegates to FilterablePickerOverlay. */
export class HistorySearchOverlay extends FilterablePickerOverlay {
  constructor(
    title: Text | string,
    entries: readonly string[],
    theme: SelectListTheme,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    const titleStr = typeof title === "string" ? title : "History Search";
    super({
      title: titleStr,
      placeholder: "Filter prompt history…",
      footer: "Enter insert · ↑/↓ move · PgUp/PgDn scroll · Esc close",
      emptyMessage: "  No matching history entries",
      maxVisible: 10,
      theme,
      layout: { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 72 },
      items: entries.map((value) => ({
        value,
        label: value.replace(/\r?\n/g, " ↵ "),
      })),
      onSelect: (item) => onSelect(item.value),
      onCancel,
    });
  }
}

export class OmaTranscriptContainer
  extends Container
  implements
    NativeScrollbackCommittedRows,
    NativeScrollbackLiveRegion,
    NativeScrollbackReplay,
    RenderStablePrefix,
    TerminalFrameProvider
{
  /** Rows already written to native scrollback (acknowledged frontier). */
  private committedRows = 0;
  /** Desired commit boundary set by the render shell each frame. */
  private targetCommittedRows = 0;
  private lastLines: string[] = [];
  private lastWidth = -1;
  private nextBatchId = 1;
  private offeredBatch: { id: number; end: number } | undefined;
  private deferCommit = false;

  /** While a run is live, mermaid/code rows may still re-layout on a later
   *  chunk; don't advance the scrollback frontier until the run settles
   *  (omp defers native-scrollback settling wholesale for live blocks). */
  setDeferCommit(defer: boolean): void {
    this.deferCommit = defer;
  }

  /** Records the desired commit boundary; `peekFinalizedBatch` turns it into
   *  an incremental history packet only when it is behind the frontier. */
  setNativeScrollbackCommittedRows(rows: number): void {
    if (this.deferCommit) return;
    this.targetCommittedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
    if (this.targetCommittedRows < this.committedRows)
      this.targetCommittedRows = this.committedRows;
  }

  getNativeScrollbackLiveRegionStart(): number | undefined {
    return this.committedRows;
  }

  getRenderStablePrefixRows(): number {
    return this.committedRows;
  }

  prepareNativeScrollbackReplay(): void {
    this.lastLines = [];
    this.lastWidth = -1;
  }

  override clear(): void {
    super.clear();
    this.lastLines = [];
    this.lastWidth = -1;
    this.committedRows = 0;
    this.targetCommittedRows = 0;
    this.offeredBatch = undefined;
  }

  /** Total rows currently in the live (not-yet-committed) tail. */
  liveRowCount(width: number): number {
    this.lastWidth = width;
    let rows = 0;
    for (
      let i = Math.min(this.committedRows, this.children.length);
      i < this.children.length;
      i++
    ) {
      rows += this.children[i]!.render(width).length;
    }
    return rows;
  }

  /** Render only the live tail, keeping the most recent `maxRows`.
   *  Never forces a full-history `super.render(width)`: committed rows are
   *  already in terminal scrollback and never read from `lastLines` here. */
  renderViewport(width: number, maxRows: number): string[] {
    if (this.lastWidth !== width) {
      this.lastWidth = width;
      this.lastLines = [];
    }
    const live: string[] = [];
    for (
      let i = Math.min(this.committedRows, this.children.length);
      i < this.children.length;
      i++
    ) {
      const childLines = this.children[i]!.render(width);
      for (const line of childLines) live.push(line);
    }
    if (live.length > maxRows) return live.slice(live.length - maxRows);
    return live;
  }

  /** Offer the next uncommitted prefix as one history batch (omp peek).
   *  Returns only the *new* rows (from the frontier), never the cumulative
   *  prefix, so the terminal appends each packet exactly once. Does NOT gate
   *  on `lastWidth === width`: `renderOfferedHistory(width)` renders directly
   *  via `renderRange(..., width)`, and gating on `lastWidth` dropped the
   *  entire replay batch whenever `available === 0` (tall chrome on resize)
   *  skipped `renderViewport()`. */
  peekFinalizedBatch(width: number): { id: number; end: number } | undefined {
    if (this.deferCommit) return undefined;
    if (this.offeredBatch !== undefined) return this.offeredBatch;
    if (width <= 0 || this.targetCommittedRows <= this.committedRows) return undefined;
    const end = this.targetCommittedRows;
    const batch = { id: this.nextBatchId++, end };
    this.offeredBatch = batch;
    return batch;
  }

  /** Acknowledges the offered batch, advancing the frontier (omp ack). */
  acknowledgeFinalizedBatch(id: number): void {
    if (this.offeredBatch === undefined || this.offeredBatch.id !== id) return;
    this.committedRows = Math.max(this.committedRows, this.offeredBatch.end);
    this.offeredBatch = undefined;
  }

  /** Render the currently-offered history packet rows (no full re-render). */
  renderOfferedHistory(width: number): { id: number; rows: string[] } | undefined {
    const batch = this.peekFinalizedBatch(width);
    if (!batch) return undefined;
    return { id: batch.id, rows: this.renderRange(this.committedRows, batch.end, width) };
  }

  /** Render the children in `[start, end)` as rows (used for history packets). */
  renderRange(start: number, end: number, width: number): string[] {
    const out: string[] = [];
    for (let i = start; i < Math.min(end, this.children.length); i++) {
      const childLines = this.children[i]!.render(width);
      for (const line of childLines) out.push(line);
    }
    return out;
  }

  /** Child-index commit boundary for a viewport budget: the largest prefix
   *  whose rendered tail fits `availableRows` PHYSICAL rows. The previous
   *  arithmetic (childCount - availableRows, in the frame provider)
   *  silently assumed one row per child; a Text that wraps at the current
   *  width renders several, which drifted the frontier mid-block on narrow
   *  terminals and resizes. The LAST child always stays live (a block
   *  taller than the whole viewport still shows its tail, never a blank
   *  transcript), and `liveStartChild` keeps streaming groups out of the
   *  scrollback. */
  fitTailBoundary(width: number, availableRows: number, liveStartChild?: number): number {
    const n = this.children.length;
    if (n === 0) return 0;
    if (availableRows <= 0) {
      return liveStartChild !== undefined ? Math.min(n, Math.max(0, liveStartChild)) : n;
    }
    let boundary = n - 1;
    let used = this.children[n - 1]!.render(width).length;
    for (let i = n - 2; i >= 0; i--) {
      const height = this.children[i]!.render(width).length;
      if (used + height > availableRows) break;
      used += height;
      boundary = i;
    }
    if (liveStartChild !== undefined) boundary = Math.min(boundary, Math.max(0, liveStartChild));
    return boundary;
  }

  /** Frame provider viewport = full render; history = uncommitted frontier
   *  rows to append to native scrollback. */
  renderFrame(opts: { columns: number; rows: number }): FramePlan {
    const viewport = this.render(opts.columns);
    const batch = this.peekFinalizedBatch(opts.columns);
    return {
      viewport,
      history: batch
        ? { id: batch.id, rows: this.renderRange(this.committedRows, batch.end, opts.columns) }
        : undefined,
    };
  }

  /** Replay the committed prefix after a resize/replay (force full re-compose). */
  beginReplay(): void {
    this.offeredBatch = undefined;
    this.committedRows = 0;
    this.targetCommittedRows = 0;
    this.lastLines = [];
    this.lastWidth = -1;
  }

  /** Graceful shutdown flush: offer + ack the committed prefix, then reset. */
  beginHistoryFlush(): void {
    const batch = this.peekFinalizedBatch(this.lastWidth);
    if (batch) this.acknowledgeFinalizedBatch(batch.id);
    this.beginReplay();
  }

  override render(width: number): string[] {
    // Steady-state frames reuse the committed prefix (rows already in native
    // scrollback) and only compose children at/after the seam, making each
    // frame O(live tail) instead of O(history). A width change forces a full
    // re-layout of the prefix too.
    if (this.lastWidth !== width || this.lastLines.length === 0 || this.children.length === 0) {
      const all = super.render(width);
      this.lastLines = all;
      this.lastWidth = width;
      return all;
    }
    const start = Math.min(this.committedRows, this.children.length);
    // Cheap committed-prefix audit: the last committed row must still match
    // its cached bytes, otherwise the prefix drifted and we re-layout fully.
    if (start > 0) {
      const audit = this.children[start - 1]?.render(width)?.[0] ?? "";
      if (audit !== this.lastLines[start - 1]) {
        const all = super.render(width);
        this.lastLines = all;
        this.lastWidth = width;
        return all;
      }
    }
    const prefix = this.lastLines.slice(0, Math.max(0, start));
    const tail: string[] = [];
    for (let i = start; i < this.children.length; i++) {
      tail.push(...this.children[i]!.render(width));
    }
    this.lastLines = [...prefix, ...tail];
    return this.lastLines;
  }
}
