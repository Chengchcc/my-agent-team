/** OSC 66 text sizing (Kitty ≥0.33, Ghostty): `\x1b]66;s=<n>;<payload>\x1b\\`
 *  makes the terminal paint the payload at `n`× the cell size while it still
 *  occupies its natural cell width. omp uses it to draw h1 headings double
 *  size — the one visual-hierarchy cue a terminal otherwise cannot express.
 *
 *  Support is DETECTED but never assumed: a terminal that does not implement
 *  OSC 66 swallows the whole sequence, payload included, so the heading would
 *  render as a BLANK line. Unknown terminals therefore stay off and only the
 *  known implementations opt in; OMA_TEXT_SIZING=1/0 overrides either way. */
const SUPPORTING_TERM_PROGRAMS = new Set(["ghostty", "kitty", "wezterm"]);

let override: boolean | undefined;

/** Whether this terminal is known to implement OSC 66. */
export function textSizingSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.OMA_TEXT_SIZING;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_EXECUTABLE) return true;
  const term = env.TERM ?? "";
  if (term.includes("kitty") || term.includes("ghostty") || term.includes("wezterm")) return true;
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  return SUPPORTING_TERM_PROGRAMS.has(program);
}

export function textSizingEnabled(): boolean {
  return override ?? textSizingSupported();
}

/** Force the capability on/off (tests, an explicit host setting, `undefined`
 *  to fall back to detection). */
export function setTextSizingEnabled(next: boolean | undefined): void {
  override = next;
}
