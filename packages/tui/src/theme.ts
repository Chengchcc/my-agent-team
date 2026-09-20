/** TUI color tokens. Every SGR color decision in the TUI routes through
 *  `tuiTheme`, so a future theme feature swaps this one object instead of
 *  hunting escape codes across renderers.
 *
 *  The default theme ports omp's "obsidian dark" palette (oh-my-pi
 *  theme/defaults/obsidian.json): warm-black neutrals, a violet accent, jade
 *  success, crimson error. Values are 24-bit-color SGR strings; terminals
 *  without truecolor degrade per their own palette. Attributes (bold,
 *  italic, underline, strike) are NOT themed — a theme recolors, it does not
 *  restyle structure.
 *
 *  Ten color tokens, each a ROLE a renderer can name without knowing the
 *  palette: one brand accent, three verdict colors, one informational, two
 *  text tiers, three surfaces. Anything finer (a second orange, a separate
 *  heading tint) was tried and collapsed — tokens nobody can name from the
 *  sitting surface are taxonomy, not theme. */

export interface TuiTheme {
  /** Brand accent: block titles, spinner + sweep band, selected markers,
   *  inline code, the banner. obsidian violet. */
  readonly accent: string;
  /** Paths, links, notice lines, informational chrome. obsidian cyan. */
  readonly info: string;
  /** Success marks, diff added, clean git. obsidian jade. */
  readonly success: string;
  /** Errors, failures, diff removed. obsidian crimson. */
  readonly error: string;
  /** Warnings and pressure (dirty git, hot context). obsidian gold. */
  readonly warning: string;
  /** Secondary text: timestamps, meta, settled rows, hints, quotes. */
  readonly dim: string;
  /** Faintest marks: markdown markers, hr, quote bars — structure that
   *  should sit below the dim tier. */
  readonly faint: string;
  /** Selected-row / chip / meter surface. obsidian glass. Inside an overlay
   *  this is ALSO the selection contrast against bgOverlay. */
  readonly bgPanel: string;
  /** Full-overlay surface. obsidian smoke. */
  readonly bgOverlay: string;
  /** "Running jobs" chip surface — jade sunk toward the panel tone. */
  readonly bgChipOk: string;
}

/** "#rrggbb" → 24-bit foreground SGR. Module-private: themes are declared as
 *  hex constants and materialized once; call sites never build SGR strings. */
function fg(hex: string): string {
  return `\u001b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}

/** "#rrggbb" → 24-bit background SGR. */
function bg(hex: string): string {
  return `\u001b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}

/** omp obsidian dark, as hex — kept visible for diffing against upstream. */
const OBSIDIAN = {
  glass: "#1a1816",
  smoke: "#2b2825",
  violet: "#9d7aff",
  jade: "#52e8a0",
  crimson: "#ff5570",
  cyan: "#5cd9ff",
  gold: "#ffc942",
  muted: "#8a857f",
  dim: "#4a4642",
} as const;

export const obsidianDarkTheme: TuiTheme = {
  accent: fg(OBSIDIAN.violet),
  info: fg(OBSIDIAN.cyan),
  success: fg(OBSIDIAN.jade),
  error: fg(OBSIDIAN.crimson),
  warning: fg(OBSIDIAN.gold),
  dim: fg(OBSIDIAN.muted),
  faint: fg(OBSIDIAN.dim),
  bgPanel: bg(OBSIDIAN.glass),
  bgOverlay: bg(OBSIDIAN.smoke),
  bgChipOk: bg("#20362b"),
};

/** The active theme. Single swap point for the future theme feature
 *  (settings key → assign another TuiTheme here, re-render). */
export const tuiTheme: TuiTheme = obsidianDarkTheme;
