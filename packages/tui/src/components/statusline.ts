import { tuiTheme } from "../theme.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

/**
 * Terminal-native status bar & header renderers.
 * Pure ANSI functions, no component state.
 */

export interface StatusSegment {
  text: string;
  /** Render as a filled pill badge (tinted background + bold label). */
  chip?: boolean;
  /** Foreground ANSI for plain segments (default reset). */
  fg?: string;
  /** Background ANSI for chip segments (e.g. `\x1b[48;2;...m`). */
  bg?: string;
  /** Drop priority when terminal width is tight: smaller = higher priority
   *  (kept longest). Default 5. */
  priority?: number;
}

export type FlexStatusSegment = StatusSegment;

/** Clean rectangular terminal badge: tinted bg + padded bold label, with
 *  explicit SGR reset so foreground color never leaks into neighbors. */
export function chip(text: string, bgAnsi: string, fgAnsi = "\x1b[37m"): string {
  if (!bgAnsi) return `\x1b[7m ${text} \x1b[0m`;
  return `${bgAnsi}\x1b[1m${fgAnsi} ${text} \x1b[0m`;
}

function renderSegment(seg: StatusSegment): string {
  if (seg.chip) {
    return chip(seg.text, seg.bg ?? tuiTheme.bgPanel, seg.fg ?? "\x1b[37m");
  }
  return `${seg.fg ?? "\x1b[0m"}${seg.text}\x1b[0m`;
}

/** Join a segment array with subtle dot separators. */
export function renderStatusBar(segs: readonly StatusSegment[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    if (out.length > 0) out.push(`${tuiTheme.dim} · \x1b[0m`);
    out.push(renderSegment(s));
  }
  return out.join("");
}

/** Compact block-character utilization meter (e.g. `████░░░░ 42%`). */
export function renderMeter(pct: number, cells = 6): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * cells);
  const barColor =
    clamped >= 90 ? tuiTheme.error : clamped >= 70 ? tuiTheme.warning : tuiTheme.accent;
  const filledPart = filled > 0 ? `${barColor}${"█".repeat(filled)}\x1b[0m` : "";
  const emptyPart =
    cells - filled > 0 ? `${tuiTheme.faint}${"░".repeat(cells - filled)}\x1b[0m` : "";
  const pctColor = clamped >= 90 ? tuiTheme.error : clamped >= 70 ? tuiTheme.warning : tuiTheme.dim;
  return `${filledPart}${emptyPart} ${pctColor}${clamped}%\x1b[0m`;
}

/** True two-column (left + right) responsive terminal status bar.
 *  Drops lowest-priority segments (largest `priority` number) first when
 *  `left + gap + right > width`, so critical indicators (mode, model, ctx%)
 *  survive narrow 60–80 column terminals without mid-word truncation. */
export function renderFlexStatusBar(opts: {
  left: readonly FlexStatusSegment[];
  right: readonly FlexStatusSegment[];
  width: number;
  separator?: string;
}): string {
  const width = Math.max(1, opts.width);
  const sep = opts.separator ?? `${tuiTheme.dim} · \x1b[0m`;
  const sepWidth = visibleWidth(sep);

  type Tagged = {
    side: "left" | "right";
    order: number;
    priority: number;
    rendered: string;
    w: number;
  };
  const items: Tagged[] = [];
  opts.left.forEach((s, idx) => {
    if (!s.text) return;
    const rendered = renderSegment(s);
    items.push({
      side: "left",
      order: idx,
      priority: s.priority ?? 5,
      rendered,
      w: visibleWidth(rendered),
    });
  });
  opts.right.forEach((s, idx) => {
    if (!s.text) return;
    const rendered = renderSegment(s);
    items.push({
      side: "right",
      order: idx,
      priority: s.priority ?? 5,
      rendered,
      w: visibleWidth(rendered),
    });
  });

  const measureSide = (side: "left" | "right", active: readonly Tagged[]): number => {
    const list = active.filter((i) => i.side === side);
    if (list.length === 0) return 0;
    return list.reduce((acc, i) => acc + i.w, 0) + (list.length - 1) * sepWidth;
  };

  const active = [...items];
  const minGap = 2;
  while (active.length > 1) {
    const lw = measureSide("left", active);
    const rw = measureSide("right", active);
    const needed = lw + rw + (lw > 0 && rw > 0 ? minGap : 0);
    if (needed <= width) break;
    // Drop the lowest-priority (highest priority number) item; tie-break right-most on left side.
    let dropIdx = 0;
    for (let i = 1; i < active.length; i++) {
      const a = active[i]!;
      const b = active[dropIdx]!;
      if (a.priority > b.priority || (a.priority === b.priority && a.order >= b.order)) {
        dropIdx = i;
      }
    }
    active.splice(dropIdx, 1);
  }

  const leftStr = active
    .filter((i) => i.side === "left")
    .sort((a, b) => a.order - b.order)
    .map((i) => i.rendered)
    .join(sep);
  const rightStr = active
    .filter((i) => i.side === "right")
    .sort((a, b) => a.order - b.order)
    .map((i) => i.rendered)
    .join(sep);

  const lw = visibleWidth(leftStr);
  const rw = visibleWidth(rightStr);
  if (lw === 0 && rw === 0) return "";
  if (rw === 0) return truncateToWidth(leftStr, width, "…");
  if (lw === 0) {
    const pad = Math.max(0, width - rw);
    return `${" ".repeat(pad)}${truncateToWidth(rightStr, width, "…")}`;
  }
  const gap = width - lw - rw;
  if (gap >= 1) {
    return `${leftStr}${" ".repeat(gap)}${rightStr}`;
  }
  return truncateToWidth(`${leftStr} ${rightStr}`, width, "…");
}

/** Compact tool-card header:  icon title · description · meta  */
export function renderToolHeader(opts: {
  icon?: string;
  title: string;
  description?: string;
  meta?: string[];
  spinnerFrame?: number;
  titleColor?: string;
  dimColor?: string;
}): string {
  const icon = opts.icon ? `${opts.icon} ` : "";
  const titleColor = opts.titleColor ?? "\u001b[1m";
  const title = `${titleColor}${icon}${opts.title}\u001b[22m\u001b[0m`;
  const meta = opts.meta?.filter(Boolean) ?? [];
  const parts: string[] = [];
  if (opts.description) parts.push(opts.description);
  if (meta.length > 0) parts.push(meta.join(" · "));
  if (parts.length > 0) {
    const dim = opts.dimColor ?? tuiTheme.dim;
    return `${title} ${dim}${parts.join(" · ")}\u001b[0m`;
  }
  return title;
}
