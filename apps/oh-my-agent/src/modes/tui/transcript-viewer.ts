import { Container, matchesKey, type Terminal, type TUI, truncateToWidth } from "@chengchenccc/tui";
import type { TranscriptItem, TuiViewState } from "./view-state.js";

/** Full-screen transcript viewer (alt-screen-free): an overlay covering the
 *  whole terminal that renders the session transcript from the LIVE view
 *  state, with an app-controlled scroll offset.
 *
 *  Why an overlay instead of native scrolling: while a run streams, history
 *  appends scroll the pane every frame, so terminals with scroll-on-output
 *  yank the user back to the bottom. The viewer owns its scroll offset as a
 *  plain variable — scrolling only moves the render window, and terminal
 *  scroll events are irrelevant. Refreshes its buffer at most every 500ms
 *  while open, so a running stream stays visible and keeps flowing. */

const REFRESH_MS = 500;
/** Lines shown below the header row. */
const HEADER_ROWS = 1;

export interface TranscriptViewerDeps {
  tui: TUI;
  terminal: Terminal;
  getRuns: () => TuiViewState["runs"];
  itemRenderer: {
    renderItem(item: TranscriptItem, state: TuiViewState): string[];
  };
  state: TuiViewState;
  onClose: () => void;
}

function collectLines(
  runs: TuiViewState["runs"],
  render: (item: TranscriptItem) => string[],
): string[] {
  const out: string[] = [];
  for (const run of runs) {
    for (const item of run.items) {
      for (const line of render(item)) out.push(line);
    }
    out.push("");
  }
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export class TranscriptViewer extends Container {
  private offsetFromEnd = 0;
  private buffer: string[] = [];
  private bufferAt = 0;

  constructor(private readonly deps: TranscriptViewerDeps) {
    super();
  }

  private rebuild(): void {
    const state = this.deps.state;
    this.buffer = collectLines(this.deps.getRuns(), (item: TranscriptItem) =>
      this.deps.itemRenderer.renderItem(item, state),
    );
    this.bufferAt = Date.now();
    const maxOffset = Math.max(0, this.buffer.length - 1);
    if (this.offsetFromEnd > maxOffset) this.offsetFromEnd = maxOffset;
  }

  override render(width: number): string[] {
    if (Date.now() - this.bufferAt > REFRESH_MS) this.rebuild();
    const rows = Math.max(1, this.deps.terminal.rows - HEADER_ROWS);
    const start = Math.max(0, this.buffer.length - rows - this.offsetFromEnd);
    const end = start + rows;
    const windowed = this.buffer.slice(start, end);
    const pos = `lines ${start + 1}-${end}/${this.buffer.length}`;
    const header = truncateToWidth(
      `── transcript viewer · ${pos} · ↑↓ pgup/pgdn home/end · q close `,
      width,
    );
    return [header, ...windowed];
  }

  handleInput(data: string): void {
    const rows = Math.max(1, this.deps.terminal.rows - HEADER_ROWS);
    const maxOffset = Math.max(0, this.buffer.length - rows);
    if (matchesKey(data, "up")) this.offsetFromEnd = Math.min(maxOffset, this.offsetFromEnd + 1);
    else if (matchesKey(data, "down")) this.offsetFromEnd = Math.max(0, this.offsetFromEnd - 1);
    else if (data === "\x1b[5~")
      this.offsetFromEnd = Math.min(maxOffset, this.offsetFromEnd + rows);
    else if (data === "\x1b[6~") this.offsetFromEnd = Math.max(0, this.offsetFromEnd - rows);
    else if (matchesKey(data, "home")) this.offsetFromEnd = maxOffset;
    else if (matchesKey(data, "end")) this.offsetFromEnd = 0;
    else if (data === "q" || matchesKey(data, "escape")) this.deps.onClose();
  }
}
