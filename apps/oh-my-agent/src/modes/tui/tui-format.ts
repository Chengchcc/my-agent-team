import type { DefaultTextStyle, EditorTheme, MarkdownTheme } from "@chengchenccc/tui";
import {
  applyBackgroundToLine,
  SHIMMER_TIER_OPEN,
  truncateToWidth,
  tuiTheme,
} from "@chengchenccc/tui";

export const MAX_TOOL_ARGS = 200;
export const MAX_TOOL_DETAIL = 8_000;
export const MAX_DIFF_LINES = 6;

/** Compact single-line JSON, truncated with an ellipsis marker. */
export function compactJson(value: unknown, max: number): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** Multi-line pretty JSON, truncated at MAX_TOOL_DETAIL with an ellipsis. */
export function prettyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.length > MAX_TOOL_DETAIL ? `${json.slice(0, MAX_TOOL_DETAIL)}…` : json;
}

/** Collapsed tool-result summary: prefer result.content as a human
 *  sentence, keeping the exit marker; fall back to compact JSON only
 *  when content is not a string. */
export function summarizeResult(result: Readonly<Record<string, unknown>>): string {
  const content = result.content;
  if (typeof content === "string") {
    const lines = content
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const isError = result.isError === true || result.error !== undefined;
    // Success: strip the `[exit: 0]` notice (omp's stripExitCodeNotice) so
    // the line stays human; error keeps a red exit marker (renderTool colors it).
    const contentLines = isError ? lines : lines.filter((l) => !/^\[exit: \d+\]$/.test(l));
    if (contentLines.length > 0) {
      const first = contentLines[0]!;
      const exit = isError ? lines.find((l) => /^\[exit: \d+\]$/.test(l)) : undefined;
      const summary = exit && exit !== first ? `${first} · ${exit}` : first;
      const remaining = contentLines.filter((l) => l !== first && l !== exit).length;
      const suffix =
        remaining > 0 ? ` (+${remaining} line${remaining === 1 ? "" : "s"}, ctrl+o)` : "";
      const base = summary.length > MAX_TOOL_ARGS ? `${summary.slice(0, MAX_TOOL_ARGS)}…` : summary;
      return `${base}${suffix}`;
    }
    return "";
  }
  const json = JSON.stringify(result) ?? "";
  if (json.length <= MAX_TOOL_ARGS) return json;
  let firstLine = json;
  for (const value of Object.values(result)) {
    if (typeof value === "string" && value.trim()) {
      firstLine = value.trim().split("\n", 1)[0] ?? value;
      break;
    }
  }
  if (firstLine.length > MAX_TOOL_ARGS) {
    firstLine = `${firstLine.slice(0, MAX_TOOL_ARGS)}…`;
  }
  return `${firstLine} (+${json.length - firstLine.length} chars, ctrl+o)`;
}

/** Pi-style collapsed arg summaries: a human sentence per common tool
 *  (bash's `$ cmd`, read's `path:a-b`), falling back to compact JSON. */
export const TOOL_ARG_SUMMARIES: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (i) => {
    const command = typeof i.command === "string" ? i.command : "";
    const timeout =
      typeof i.timeout === "number" ? ` (timeout ${Math.round(i.timeout / 1000)}s)` : "";
    return `$ ${command}${timeout}`;
  },
  read: (i) => {
    const path = typeof i.path === "string" ? i.path : "";
    if (typeof i.offset === "number" && typeof i.limit === "number") {
      return `${path}:${i.offset}-${i.offset + i.limit - 1}`;
    }
    return path;
  },
  write: (i) => (typeof i.path === "string" ? i.path : ""),
  edit: (i) => (typeof i.path === "string" ? i.path : ""),
  grep: (i) => {
    const pattern = typeof i.pattern === "string" ? i.pattern : "";
    const path = typeof i.path === "string" ? ` ${i.path}` : "";
    return `${pattern}${path}`;
  },
  hub: (i) => {
    const op = typeof i.op === "string" ? i.op : "";
    if (op === "wait") {
      return Array.isArray(i.ids) ? `wait ${i.ids.length} job(s)` : "wait all jobs";
    }
    const id = typeof i.id === "string" ? i.id : "";
    if (op === "steer" && typeof i.prompt === "string") {
      return `steer ${id}: ${i.prompt.slice(0, 40)}`;
    }
    return [op, id].filter(Boolean).join(" ");
  },
  task: (i) => {
    const label = typeof i.label === "string" ? i.label : "";
    return label || "fan out subagents";
  },
  todo_write: (i) => {
    if (!Array.isArray(i.items)) return "update task list";
    const first = i.items.find(
      (v): v is { text: string } =>
        typeof v === "object" && v !== null && "text" in v && typeof v.text === "string",
    );
    const head = first ? `: ${first.text.slice(0, 40)}` : "";
    return `${i.items.length} item(s)${head}`;
  },
  learn: (i) => {
    const memory = typeof i.memory === "string" ? i.memory.replace(/\s+/g, " ").slice(0, 60) : "";
    return memory || "capture a lesson";
  },
  ask_question: (i) => {
    const first = Array.isArray(i.questions) ? i.questions[0] : undefined;
    if (
      typeof first === "object" &&
      first !== null &&
      "question" in first &&
      typeof first.question === "string"
    ) {
      return first.question.slice(0, 60);
    }
    return "ask the user";
  },
  eval: (i) => {
    const code = typeof i.code === "string" ? (i.code.split("\n", 1)[0] ?? "") : "";
    return code.trim().slice(0, 60) || "run sandboxed code";
  },
  workflow_run: (i) => {
    if (typeof i.name === "string" && i.name) return i.name;
    return "run a workflow script";
  },
  browser: (i) => {
    const action = typeof i.action === "string" ? i.action : "";
    const url = typeof i.url === "string" ? ` ${i.url}` : "";
    return `${action}${url}`.trim() || "browser";
  },
  web_search: (i) => (typeof i.query === "string" ? i.query : "search the web"),
  web_fetch: (i) => (typeof i.url === "string" ? i.url : "fetch a url"),
  ls: (i) => dirSummary(i),
  tree: (i) => dirSummary(i),
  skill_load: (i) => {
    const name = typeof i.name === "string" ? i.name : "";
    return name || "load a skill";
  },
  read_image: (i) => {
    const path = typeof i.path === "string" ? i.path : "";
    return path || "read an image";
  },
  recall: (i) => {
    const query = typeof i.query === "string" ? i.query : "";
    return query || "recall memories";
  },
  retain: (i) => {
    const content =
      typeof i.content === "string" ? i.content.replace(/\s+/g, " ").slice(0, 60) : "";
    return content || "retain a fact";
  },
};

function dirSummary(i: Record<string, unknown>): string {
  const path = typeof i.path === "string" ? i.path : "";
  return path || ".";
}

export function summarizeToolArgs(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const summarize = TOOL_ARG_SUMMARIES[toolName];
  if (summarize) {
    const summary = summarize(input);
    if (summary.trim()) return summary;
  }
  return compactJson(input, MAX_TOOL_ARGS);
}
export const EDITOR_THEME: EditorTheme = {
  borderColor: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  selectList: {
    selectedPrefix: (s) => `${tuiTheme.accent}${s}\u001b[0m`,
    selectedText: (s) => `\u001b[1m${s}\u001b[0m`,
    description: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
    scrollInfo: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
    noMatch: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  },
};

/** Bash keywords that get a distinct color in tool command lines. */
const BASH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "in",
  "select",
  "return",
  "export",
  "local",
]);

const styleBash = {
  keyword: (s: string) => `${tuiTheme.accent}${s}\u001b[0m`,
  string: (s: string) => `${tuiTheme.accent}${s}\u001b[0m`,
  comment: (s: string) => `${tuiTheme.dim}${s}\u001b[0m`,
  flag: (s: string) => `${tuiTheme.warning}${s}\u001b[0m`,
};

/** Style one bash command line: strings cyan, comments dim, keywords
 *  magenta, flags yellow — unmatched runs stay default, so the row reads as
 *  partially highlighted (omp formatBashCommandLines-style; its
 *  highlightCode is a Rust FFI, this is the ~30-line equivalent). */
export function styleBashLine(line: string): string {
  const out: string[] = [];
  const re = /("(?:[^"\\]|\\.)*")|('(?:[^'])*')|(#[^\n]*)|(\S+)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1]) out.push(styleBash.string(m[1]));
    else if (m[2]) out.push(styleBash.string(m[2]));
    else if (m[3]) out.push(styleBash.comment(m[3]));
    else {
      const word = m[0]!;
      if (word.startsWith("-") && word.length > 1) out.push(styleBash.flag(word));
      else if (BASH_KEYWORDS.has(word)) out.push(styleBash.keyword(word));
      else out.push(word);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out.join("");
}

/** Sortable local timestamp for the session picker: MM-DD HH:MM. The
 *  picker lists newest-first, and a coarse "2m"/"now" label made distinct
 *  sessions look identical (and ordered arbitrarily) whenever they were
 *  touched in the same minute. */
export function sessionStamp(modifiedAt: number, now: number = Date.now()): string {
  const d = new Date(modifiedAt);
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  // Past years keep the year prefix so the rendered column is monotonic:
  // MM-DD alone sorts 12-31 above 01-01 of the NEXT year.
  return d.getFullYear() === new Date(now).getFullYear() ? stamp : `${d.getFullYear()}-${stamp}`;
}

/** Relative age — the at-a-glance half of the resume picker's time column.
 *  The absolute stamp stays next to it: age alone was unreadable for ordering
 *  (sessions touched in the same minute all read "now"), the stamp alone made
 *  the reader do date arithmetic. */
export function relativeAge(modifiedAt: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - modifiedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** The fields a resume row needs. Structural on purpose: the picker, the text
 *  listing and /resume's argument completion all pass their own row shape. */
export interface SessionRowInput {
  readonly id: string;
  readonly title?: string;
  readonly summary?: string;
  readonly preview?: string;
  readonly modifiedAt: number;
  readonly workspace?: string;
  readonly forkOf?: string;
}

/** One resume-list row: `label` is the time column (absolute stamp + age),
 *  `description` is title — summary. Single home for the row shape so the
 *  picker, the text fallback listing and the completion hint cannot drift
 *  apart (they each carried their own copy of `title ?? preview`). */
export function sessionRow(
  session: SessionRowInput,
  now: number = Date.now(),
): { label: string; description: string } {
  const base = session.title ?? (session.preview || session.id.slice(0, 8));
  // A summary without a title stands alone (the preview is a weaker signal
  // than a generated sentence, so it never outranks it).
  const description = session.summary
    ? session.title
      ? `${base} — ${session.summary}`
      : session.summary
    : base;
  const fork = session.forkOf ? ` \u2442 ${session.forkOf.slice(0, 8)}` : "";
  const workspace = session.workspace ? ` [${session.workspace}]` : "";
  return {
    label: `${sessionStamp(session.modifiedAt, now)} · ${relativeAge(session.modifiedAt, now)}`,
    description: `${description}${fork}${workspace}`,
  };
}

/** Markdown theme for assistant output, aligned to omp's `md*` palette
 *  (modes/theme/dark.json): amber headings, purple inline code, blue code
 *  blocks, accent bullets. The old theme was "bold, no colors", which left a
 *  long report reading as one undifferentiated slab — headings had no visual
 *  weight beyond bold, and dim bullets vanished into the background.
 *  256-color forms of omp's truecolor values (pip's 16-color terminals). */
/** omp's `heading` is a COLOR-only function (#febc38): the renderer adds
 *  bold (h2) and bold+underline (h1) per level, so bolding here would double
 *  the escape and flatten the level difference. */
const MD_HEADING = (s: string): string => `${tuiTheme.accent}${s}\u001b[0m`;
const MD_MARKER = (s: string): string => `${tuiTheme.faint}${s}\u001b[0m`; // dim: level info, quiet
const MD_CODE = (s: string): string => `${tuiTheme.accent}${s}\u001b[0m`;
// Code-block body: default foreground (obsidian's silver IS the default fg —
// the old #9CDCFE tint was a second "default text" for no reason).
const MD_CODE_BLOCK = (s: string): string => s;

export const MARKDOWN_THEME: MarkdownTheme = {
  heading: MD_HEADING,
  // The level-3+ `###` run stays readable as a level marker without shouting:
  // omp paints it in the heading color, we dim it (same information, less ink).
  headingMarker: MD_MARKER,
  link: (s) => `${tuiTheme.info}${s}\u001b[0m`, // #0088fa
  linkUrl: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  code: MD_CODE,
  codeBlock: MD_CODE_BLOCK,
  codeBlockBorder: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  quote: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  quoteBorder: (s) => `${tuiTheme.faint}${s}\u001b[0m`,
  hr: (s) => `${tuiTheme.faint}${s}\u001b[0m`,
  // omp: mdListBullet = accent. oma's accent is the loader cyan — a dim bullet
  // was invisible against a translucent background.
  listBullet: (s) => `${tuiTheme.accent}${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  italic: (s) => `\u001b[3m${s}\u001b[0m`,
  strikethrough: (s) => `\u001b[9m${s}\u001b[0m`,
  underline: (s) => `\u001b[4m${s}\u001b[0m`,
};

/** User bubble: markdown text on a deep-blue background tint with cyan
 *  text (pi's UserMessageComponent look). */
export const USER_TEXT_STYLE: DefaultTextStyle = {
  color: (s) => `${tuiTheme.accent}${s}\u001b[0m`,
  bgColor: (s) => `${tuiTheme.bgPanel}${s}\u001b[0m`,
};

/** Compact token count for the header: 12k / 200k. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

/** Compact model meta line (pi's ModelBrowser columns): display name,
 *  context window, $in/out per-million cost (free when both legs are zero),
 *  current-model mark, and an over-context warning when the session's
 *  estimated tokens exceed the model's window. */
export function formatModelMeta(
  model: {
    displayName: string;
    contextWindow: number;
    cost?: { input: number; output: number };
  },
  opts: { current?: boolean; contextTokens?: number } = {},
): string {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  const cost = input <= 0 && output <= 0 ? "free" : `$${input}/${output}`;
  const parts = [model.displayName, `ctx ${formatTokens(model.contextWindow)}`, cost];
  if (opts.current) parts.push("current");
  if (opts.contextTokens !== undefined && model.contextWindow < opts.contextTokens) {
    parts.push("over current context!");
  }
  return parts.join(" · ");
}

export const OVERLAY_BG = (s: string): string => `${tuiTheme.bgOverlay}${s}\u001b[0m`;

/** Pad + frame overlay lines so they cover the underlying transcript
 *  (a plain Container's unshaped whitespace lets the base text bleed
 *  through). */
export function overlayLines(lines: readonly string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 2);
  return lines.map((line) => {
    const content = truncateToWidth(line, innerWidth, "", true);
    return `${tuiTheme.accent}\u2502\u001b[0m${applyBackgroundToLine(content, innerWidth, OVERLAY_BG)}${tuiTheme.accent}\u2502\u001b[0m`;
  });
}

/** Overlay root for the session picker: renders title + list and routes
 *  key input to the list (a plain Container has no handleInput). */
/** Clean a session title for the header line: strip markdown heading
 *  markers/whitespace, collapse whitespace, cap at 32 chars. */
export function cleanHeaderTitle(title: string): string {
  const cleaned = title
    .replace(/^[#>*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const truncated = cleaned.length > 32 ? `${cleaned.slice(0, 32)}…` : cleaned;
  return ` — ${truncated}`;
}

/** Compact git branch + dirty count for the idle status line.
 *
 * ASYNC + CACHED: the old Bun.spawnSync pair blocked the event loop
 * ~60-300ms on real repos — setBusy() runs this on every Enter, which is
 * exactly the felt "submit stall". Render paths read the cache
 * (gitStatusCached) and kick a background refresh; boot awaits one prime. */
let gitCache: { root: string; value: string; at: number } | undefined;
let gitInflight: Promise<string> | undefined;
const GIT_TTL_MS = 2_000;

async function runGitStatus(workspaceRoot: string): Promise<string> {
  try {
    const branchProc = Bun.spawn(
      ["git", "-C", workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [branchOut] = await Promise.all([
      new Response(branchProc.stdout).text(),
      branchProc.exited,
    ]);
    if (branchProc.exitCode !== 0) return "";
    const branch = branchOut.trim();
    if (!branch) return "";
    const porcelainProc = Bun.spawn(["git", "-C", workspaceRoot, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [porcelainOut] = await Promise.all([
      new Response(porcelainProc.stdout).text(),
      porcelainProc.exited,
    ]);
    if (porcelainProc.exitCode !== 0) return branch;
    const changes = porcelainOut.split("\n").filter(Boolean).length;
    return changes > 0 ? `${branch}+${changes}` : branch;
  } catch {
    return "";
  }
}

/** Refresh the cache in the background (throttled); resolves to the
 * freshest value — boot awaits it once so the header card is complete. */
export function refreshGitStatus(workspaceRoot: string): Promise<string> {
  if (gitCache?.root === workspaceRoot && Date.now() - gitCache.at < GIT_TTL_MS) {
    return Promise.resolve(gitCache.value);
  }
  gitInflight ??= runGitStatus(workspaceRoot)
    .then((value) => {
      gitCache = { root: workspaceRoot, value, at: Date.now() };
      return value;
    })
    .finally(() => {
      gitInflight = undefined;
    });
  return gitInflight;
}

/** Last cached git segment ("" until the first refresh lands). */
export function gitStatusCached(workspaceRoot: string): string {
  return gitCache?.root === workspaceRoot ? gitCache.value : "";
}

/** Shorten the workspace path for display (~/... when under HOME). */
export function formatWorkspace(root: string): string {
  const home = process.env.HOME;
  if (home && (root === home || root.startsWith(`${home}/`))) {
    return root === home ? "~" : `~${root.slice(home.length)}`;
  }
  return root;
}

/** Branch cyan, dirty count ember (omp gitClean/gitDirty colors). */
export function renderGitSegment(git: string): string {
  if (!git) return "";
  const plus = git.indexOf("+");
  if (plus === -1) return `${tuiTheme.success}${git}\u001b[0m`;
  return `${tuiTheme.info}${git.slice(0, plus)}\u001b[0m${tuiTheme.warning}${git.slice(plus)}\u001b[0m`;
}

/** omp classic-shimmer port: a cosine light band sweeps left→right across
 * streaming text (live subagent activity lines, running tool bodies).
 * Three tiers — dim (base) → normal → bold-bright at the crest — emitted
 * one ANSI pair per same-tier run, not per char. Time-sampled per frame;
 * settled lines render static dim so scrollback never freezes a band. */
const SHIMMER_SPEED_CELLS_PER_S = 30;
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF = 6;

export function shimmerText(text: string, now: number = Date.now()): string {
  const chars = Array.from(text);
  const period = chars.length + SHIMMER_PADDING * 2;
  const pos = ((now / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  // Same palette as the loader's message band (SHIMMER_TIER_OPEN): the sweep
  // and the spinner are one animation, so they must not be two colors.
  const TIER_OPEN = SHIMMER_TIER_OPEN;
  type Tier = keyof typeof TIER_OPEN;
  let out = "";
  let run = "";
  let tier: Tier | null = null;
  const flush = (): void => {
    if (tier !== null && run) out += `${TIER_OPEN[tier]}${run}\u001b[0m`;
    run = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const dist = Math.abs(i + SHIMMER_PADDING - pos);
    let next: Tier = "low";
    if (dist < SHIMMER_BAND_HALF) {
      const intensity = 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_BAND_HALF));
      next = intensity >= 0.65 ? "high" : intensity >= 0.22 ? "mid" : "low";
    }
    if (next !== tier) {
      flush();
      tier = next;
    }
    run += chars[i];
  }
  flush();
  return out;
}

/** ── Background job settlement (omp async-result analog) ──────────────────
 * A settled bg job produces ONE structured entry that feeds both audiences:
 * the model (text injected as the next run input, prefixed by the sentinel
 * so the session loop skips the user-bubble echo) and the user (compact
 * transcript rows). Output longer than INLINE_MAX spills to a file; the
 * model text then carries a preview + the file path instead of the blob. */
export interface JobSettlement {
  id: string;
  /** "bash" | "eval" | the subagent's label. */
  kindLabel: string;
  /** "exit 0" / "killed" / "timed out" / "ok" / subagent status. */
  outcome: string;
  ok: boolean;
  durationMs: number;
  /** Inline preview (already capped). */
  preview: string;
  /** Absolute path of the spilled full output, when it spilled. */
  artifactPath?: string;
}

export const SETTLEMENT_SENTINEL = "[background jobs finished]";

/** Prefixes marking a RUN INPUT that must never read as a user turn:
 *  it reaches the model (that IS the delivery) but produces no transcript
 *  echo and no session-file entry — omp's `display: false` custom message.
 *  Goal-mode steers (active/continuation/budget-limit prompts, the guided
 *  interview kickoff) ride this channel: they are multi-KB XML protocol
 *  text, and persisting them made /resume replay them as phantom bubbles. */
export const HIDDEN_INPUT_SENTINELS = [SETTLEMENT_SENTINEL, "[goal-mode]", "[ralph-loop]"] as const;

export function isHiddenInput(text: string): boolean {
  return HIDDEN_INPUT_SENTINELS.some((s) => text.startsWith(s));
}

/** Wrap a goal-mode prompt for the hidden channel. */
export function formatGoalInput(prompt: string): string {
  return `[goal-mode]\n\n${prompt}`;
}

/** Wrap a build-loop protocol prompt for the hidden channel: it is re-injected
 *  every iteration, so echoing or persisting it would flood the transcript. */
export function formatRalphInput(prompt: string): string {
  return `[ralph-loop]\n\n${prompt}`;
}

export const SETTLEMENT_INLINE_MAX = 4_000;
export const SETTLEMENT_PREVIEW_MAX = 1_500;

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** Model-facing text (omp async-result.md flavor): sentinel + one section
 * per job with preview, spill note when the full output went to a file. */
export function formatSettlementText(entries: readonly JobSettlement[]): string {
  const sections = entries.map((e) => {
    const head = `\u2500\u2500 ${e.id} (${e.kindLabel}) ${e.outcome} \u00b7 ${formatDurationMs(e.durationMs)} \u2500\u2500`;
    const lines = [head];
    if (e.preview.trim()) lines.push(e.preview.trim());
    if (e.artifactPath) lines.push(`full output: ${e.artifactPath}`);
    return lines.join("\n");
  });
  return [SETTLEMENT_SENTINEL, ...sections].join("\n\n");
}

/** User-facing transcript rows: one status row per job (omp
 * "Background job completed" row) + preview + spill pointer. */
/** One settled job, one line (omp's "Background job completed" row). A
 *  SUCCESS row is deliberately just the fact — its output already reached the
 *  model, and the panel/transcript carries the substance. A FAILURE keeps its
 *  preview and artifact pointer: a user needs the error text and the way to
 *  the full output without digging. */
export function renderSettlementRows(entries: readonly JobSettlement[]): string[] {
  const rows: string[] = [];
  for (const e of entries) {
    const mark = e.ok ? `${tuiTheme.success}\u2714\u001b[0m` : `${tuiTheme.error}\u2718\u001b[0m`;
    rows.push(
      `  ${mark} ${tuiTheme.accent}${e.id}\u001b[0m ${tuiTheme.dim}\u00b7 ${e.kindLabel} \u00b7 ${e.outcome} \u00b7 ${formatDurationMs(e.durationMs)}\u001b[0m`,
    );
    if (e.ok) continue;
    const firstLine = e.preview
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine) rows.push(`${tuiTheme.error}    ${firstLine.slice(0, 120)}\u001b[0m`);
    if (e.artifactPath) rows.push(`${tuiTheme.dim}    full output: ${e.artifactPath}\u001b[0m`);
  }
  return rows;
}

/** Threshold color for context percent (omp contextPct). */
export function contextColor(ctx: string): string {
  const m = ctx.match(/(\d+)%/);
  const pct = m ? Number(m[1]) : 0;
  if (pct >= 90) return tuiTheme.error;
  if (pct >= 70) return tuiTheme.warning;
  return tuiTheme.dim;
}

/** One-time welcome easter eggs, rotated per session (omp welcome tip). */
export const WELCOME_TIPS: readonly string[] = [
  "Tip: press ctrl+t to expand thinking, ctrl+o for tool detail",
  "Tip: /mcp test <name> checks a configured MCP server",
  "Tip: /resume lists saved sessions; /session shows the current id",
  "Tip: /workflow runs a script with subagents",
  "Tip: /exit twice quits; /help lists all commands",
];
