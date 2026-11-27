import { tuiTheme } from "../theme.ts";
import { applyBackgroundToLine, truncateToWidth, visibleWidth } from "../utils.ts";

export interface ModalFrameOptions {
  /** Top-left title rendered inside the rounded top border: `╭─ Title ───╮`. */
  title?: string;
  /** Optional top-right metadata inside the top border (e.g. `(3/18)`). */
  titleRight?: string;
  /** Optional bottom-left keycap hints rendered inside the bottom border. */
  footer?: string;
  /** Pre-rendered body lines (may contain ANSI escape codes). */
  lines: readonly string[];
  /** Total outer width in terminal cells (including borders). */
  width: number;
  /** Border SGR color prefix (default: `tuiTheme.accent`). */
  borderColor?: string;
  /** Background tint function (default: `bgOverlay`). */
  bg?: (line: string) => string;
  /** Horizontal inner padding inside side borders (default: 1). */
  paddingX?: number;
}

const DEFAULT_BG = (s: string): string =>
  tuiTheme.bgOverlay ? `${tuiTheme.bgOverlay}${s}\x1b[0m` : s;

function borderBar(
  leftCorner: string,
  rightCorner: string,
  leftLabel: string | undefined,
  rightLabel: string | undefined,
  width: number,
  color: (s: string) => string,
): string {
  const inner = Math.max(0, width - 2);
  if (inner === 0) return color(`${leftCorner}${rightCorner}`);
  const leftChunk = leftLabel ? `─ ${leftLabel} ` : "";
  const rightChunk = rightLabel ? ` ${rightLabel} ─` : "";
  const lw = visibleWidth(leftChunk);
  const rw = visibleWidth(rightChunk);

  if (lw + rw <= inner) {
    const fill = inner - lw - rw;
    return `${color(leftCorner)}${leftLabel ? `${color("─")} ${leftLabel} ` : ""}${color("─".repeat(fill))}${rightLabel ? ` ${rightLabel} ${color("─")}` : ""}${color(rightCorner)}`;
  }
  // Tight width: prioritize left title, truncated cleanly.
  if (leftLabel) {
    const budget = Math.max(0, inner - 3);
    const trimmed = truncateToWidth(leftLabel, budget, "…");
    const fill = Math.max(0, inner - 3 - visibleWidth(trimmed));
    return `${color(leftCorner)}${color("─")} ${trimmed} ${color("─".repeat(fill))}${color(rightCorner)}`;
  }
  return `${color(leftCorner)}${color("─".repeat(inner))}${color(rightCorner)}`;
}

/** Render a complete rounded-corner terminal modal (`╭─ Title ─╮` / `╰─ footer ─╯`)
 *  with opaque overlay background fill so underlying transcript rows never bleed
 *  through. */
export function renderModalFrame(opts: ModalFrameOptions): string[] {
  const width = Math.max(4, opts.width);
  const paddingX = Math.max(0, opts.paddingX ?? 1);
  const innerWidth = Math.max(1, width - 2);
  const contentWidth = Math.max(1, innerWidth - paddingX * 2);
  const bc = opts.borderColor ?? tuiTheme.accent;
  const color = (s: string): string => (bc ? `${bc}${s}\x1b[0m` : s);
  const bg = opts.bg ?? DEFAULT_BG;
  const padStr = " ".repeat(paddingX);

  const styledTitle = opts.title ? `\x1b[1m${opts.title}\x1b[0m` : undefined;
  const styledRight = opts.titleRight ? `${tuiTheme.dim}${opts.titleRight}\x1b[0m` : undefined;
  const styledFooter = opts.footer ? `${tuiTheme.dim}${opts.footer}\x1b[0m` : undefined;

  const out: string[] = [];
  out.push(
    applyBackgroundToLine(borderBar("╭", "╮", styledTitle, styledRight, width, color), width, bg),
  );
  for (const raw of opts.lines) {
    if (raw === "---") {
      out.push(
        applyBackgroundToLine(
          `${color("├")}${color("─".repeat(innerWidth))}${color("┤")}`,
          width,
          bg,
        ),
      );
      continue;
    }
    const fitted = truncateToWidth(raw, contentWidth, "…", true);
    const padded = `${padStr}${fitted}${padStr}`;
    const body = applyBackgroundToLine(padded, innerWidth, bg);
    out.push(applyBackgroundToLine(`${color("│")}${body}${color("│")}`, width, bg));
  }
  out.push(
    applyBackgroundToLine(borderBar("╰", "╯", styledFooter, undefined, width, color), width, bg),
  );
  return out;
}
