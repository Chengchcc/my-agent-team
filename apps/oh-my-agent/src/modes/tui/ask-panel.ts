import type {
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionResult,
} from "@chengchenccc/agent-contract";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  type KeybindingsManager,
  Markdown,
  matchesKey,
  renderOutputBlock,
  truncateToWidth,
  tuiTheme,
  wrapTextWithAnsi,
} from "@chengchenccc/tui";
import { MARKDOWN_THEME } from "./tui-format.js";

/** The HITL ask surface (ask_question). DOCKED, not floating: it takes over
 *  the editor slot at the bottom of the screen and grows upward. That is the
 *  point of the shape — a question the model is BLOCKED on must not read as
 *  one more transient overlay (the floating 4-row box it replaced was easy to
 *  miss on a 30-row terminal, and it covered the very input row the user was
 *  about to type in). oh-my-pi's ask dialog docks into its editor container
 *  for the same reason.
 *
 *  Faithful to that dialog's structure and keys, with two deliberate
 *  differences:
 *   - the chrome reuses oma's own framed-block primitive (renderOutputBlock),
 *     so the panel reads as part of this TUI rather than a second visual
 *     language;
 *   - the row cursor is oma's `→` (its pickers already use it); the
 *     radio/checkbox glyphs are borrowed from oh-my-pi (oma had none).
 *
 *  Held back on purpose (each is a separate concern, not an oversight):
 *   - `validation` (required/min/max) is not enforced: the Submit review counts
 *     unanswered questions and still submits, which is what oh-my-pi does;
 *   - `multiline: true` gets a one-line field — oh-my-pi's dialog has no
 *     multiline concept at all (it is select-only; free text rides the Other
 *     row), so this is an oma extension without a reference to copy;
 *   - "Chat about this" is not offered: it exists only on oh-my-pi's collab
 *     guest path (extension-ui-controller), and oma has no collab host. */

/** Fraction of the viewport the panel may occupy. */
const DIALOG_HEIGHT_RATIO = 0.7;
const MIN_DIALOG_ROWS = 12;
const MIN_BODY_ROWS = 3;
/** A long/multi-line question must not push the option list off-screen. */
const MAX_HEADER_ROWS = 4;
const MAX_DESCRIPTION_ROWS = 2;
const MAX_TAB_LABEL_WIDTH = 16;
const PAGE_ROWS = 5;
/** Cap on the preview render cache (markdown parse is the expensive part and
 *  the panel re-renders on every keystroke; distinct previews are bounded in
 *  practice, this is just a leak guard for a long session). */
const PREVIEW_CACHE_MAX = 64;

const OTHER_LABEL = "Other (type your own)";
const SUBMIT_LABEL = "Submit";
/** Row index meaning "this field belongs to the whole question", i.e. a
 *  `kind:"text"` question rather than one option row. */
const TEXT_ROW = -1;

const BOLD = "\u001b[1m";
const DIM = tuiTheme.dim;
const CYAN = tuiTheme.accent;
const GREEN = tuiTheme.success;
const YELLOW = tuiTheme.warning;
const RESET = "\u001b[0m";

const dim = (s: string): string => `${DIM}${s}${RESET}`;
const accent = (s: string): string => `${CYAN}${s}${RESET}`;

/** One selectable row of a question body. */
type AskRow =
  | { kind: "option"; value: string; label: string; description?: string; preview?: string }
  | { kind: "other"; value: undefined; label: string };

/** Committed answer state per question. The editing BUFFER lives in the
 *  question's `Input`, never here: while a field is open the Input is the
 *  single source of truth for its text (that is what the cursor renders from). */
export interface AskQuestionState {
  readonly selected: Set<string>;
  freeText: string;
  /** Note attached to one row (oh-my-pi's `n` key): it renders beside
   *  `noteRow` and dies when that row stops being the answer. */
  note: string;
  noteRow: number | null;
  /** Focused row index (select questions). */
  cursor: number;
  /** First visible body line; cursor-follow keeps it honest. */
  scroll: number;
  /** Auto-answered because the ask timed out: not the user's choice. */
  timedOut: boolean;
}

export function createAskQuestionStates(questions: readonly AskQuestionItem[]): AskQuestionState[] {
  return questions.map((q) => {
    // oh-my-pi parks the cursor on the recommended option, so a bare Enter
    // takes the recommendation. oma keys `recommended` by VALUE (the contract
    // chose that over an index because a value survives option reordering).
    const recommended = (q.options ?? []).findIndex((o) => o.value === q.recommended);
    return {
      selected: new Set<string>(),
      freeText: "",
      note: "",
      noteRow: null,
      cursor: recommended > 0 ? recommended : 0,
      scroll: 0,
      timedOut: false,
    };
  });
}

/** Rows the cursor can land on. `allowOther` defaults ON: a model must not be
 *  able to trap the user inside its own option list (oh-my-pi always offers
 *  Other for the same reason); `allowOther: false` opts out. A model option
 *  already labelled as Other takes the slot itself rather than producing two
 *  identically named rows. */
export function askRows(question: AskQuestionItem): AskRow[] {
  const options = question.options ?? [];
  const rows: AskRow[] = options.map((o) => ({
    kind: "option" as const,
    value: o.value,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    ...(o.preview ? { preview: o.preview } : {}),
  }));
  const collides = options.some((o) => o.label === OTHER_LABEL);
  if (question.kind !== "text" && question.allowOther !== false && !collides) {
    rows.push({ kind: "other", value: undefined, label: OTHER_LABEL });
  }
  return rows;
}

/** Radio for pick-one, checkbox for pick-many: the marker tells the user which
 *  mode they are in before they press anything. */
function marker(multi: boolean, checked: boolean): string {
  if (multi) return checked ? "\u2611" : "\u2610";
  return checked ? "\u25c9" : "\u25cb";
}

/** Option label as the body shows it: the recommended option badged. */
function optionLabel(question: AskQuestionItem, index: number): string {
  const option = question.options?.[index];
  if (!option) return "";
  return question.recommended === option.value && !option.label.includes("(Recommended)")
    ? `${option.label} (Recommended)`
    : option.label;
}

/** Inline free-text field. `Input` hardcodes a "> " prompt, so it is rendered
 *  two columns wider and the prompt stripped: what is left is the value plus
 *  the cursor marker at exactly `width` columns, marker intact for the TUI's
 *  hardware-cursor extraction. */
function renderField(field: Input, width: number): string {
  const [line = ""] = field.render(Math.max(3, width + 2));
  return line.slice(2);
}

/** A field row: the live buffer with the hardware cursor when the field owns
 *  input, or the committed value. An EMPTY field would otherwise paint as a
 *  blank row — the one state where the user most needs to see where to type —
 *  so a placeholder rides the empty tail. */
function fieldLine(
  field: Input,
  width: number,
  open: boolean,
  value: string,
  placeholder: string,
): string {
  if (!open) return truncateToWidth(`\u258f${value}`, width, "\u2026");
  // -2: the field marker below takes one column, plus one of slack.
  const rendered = renderField(field, Math.max(1, width - 2));
  if (field.getValue() !== "") return `\u258f${rendered}`;
  const cursor = rendered.replace(/\s+$/, "");
  return truncateToWidth(`\u258f${cursor}${dim(`  \u2014 ${placeholder}`)}`, width, "\u2026");
}

/** Markdown preview cache: `Markdown` parses in the constructor and caches its
 *  lines by (text, width), so one instance per distinct preview keeps a frame
 *  from re-parsing. Keyed by the preview text. */
const previewCache = new Map<string, Markdown>();

/** `option.preview` rendered under its option row (oh-my-pi renders it in the
 *  row too): markdown, so fenced code gets the block styling for free. */
function renderPreview(preview: string, width: number): string[] {
  const inner = Math.max(1, width - 8);
  let md = previewCache.get(preview);
  if (!md) {
    if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.clear();
    md = new Markdown(preview, 0, 0, MARKDOWN_THEME);
    previewCache.set(preview, md);
  }
  return md.render(inner).map((line) => `      ${dim("\u2502")} ${line}`);
}

/** Render one question's body rows. `open` is the field currently owning
 *  input, when it belongs to one of these rows. Every line is truncated to
 *  `width`: the panel windows body lines 1:1 (cursor-follow, scroll offset and
 *  height all count lines), so a line that the frame would have WRAPPED would
 *  silently desynchronise them. */
export function renderAskRows(
  question: AskQuestionItem,
  state: AskQuestionState,
  width: number,
  open: { row: number; field: Input; mode: "answer" | "note" } | undefined,
): { lines: string[]; lineStart: number[] } {
  const rows = askRows(question);
  const lines: string[] = [];
  const lineStart: number[] = [];
  const multi = question.multi === true;
  const push = (line: string): void => {
    lines.push(truncateToWidth(line, width, "\u2026"));
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    lineStart.push(lines.length);
    const cursor = i === state.cursor ? accent("\u2192 ") : "  ";
    // The note marker rides the row it was written on (oh-my-pi's `✎ note`).
    const noteMark =
      state.note !== "" && state.noteRow === i ? `  ${GREEN}\u270e note${RESET}` : "";
    if (row.kind === "other") {
      const answerOpen = open?.row === i && open.mode === "answer";
      const checked = state.freeText !== "" || answerOpen;
      const body =
        answerOpen || state.freeText === ""
          ? dim(OTHER_LABEL)
          : `${GREEN}\u201c${state.freeText}\u201d${RESET}`;
      push(`${cursor}${dim(marker(multi, checked))} ${body}${noteMark}`);
      if (answerOpen && open) push(`    ${renderField(open.field, width - 4)}`);
      if (open?.row === i && open.mode === "note") {
        push(`    ${dim("note:")} ${renderField(open.field, Math.max(1, width - 12))}`);
      }
      continue;
    }
    const checked = state.selected.has(row.value);
    const label = optionLabel(question, i);
    const labelColor = i === state.cursor ? BOLD : checked ? "" : DIM;
    push(
      `${cursor}${checked ? GREEN : DIM}${marker(multi, checked)}${RESET} ${labelColor}${label}${RESET}${noteMark}`,
    );
    if (row.description) {
      const wrapped = wrapTextWithAnsi(
        row.description.replace(/\s+/g, " "),
        Math.max(1, width - 8),
      );
      for (const line of wrapped.slice(0, MAX_DESCRIPTION_ROWS)) {
        push(`      ${dim(`\u21b3 ${line}`)}`);
      }
    }
    if (row.preview) {
      for (const line of renderPreview(row.preview, width)) push(line);
    }
    if (open?.row === i && open.mode === "note") {
      push(`    ${dim("note:")} ${renderField(open.field, Math.max(1, width - 12))}`);
    }
  }
  lineStart.push(lines.length);
  return { lines, lineStart };
}

function questionTitleLines(question: AskQuestionItem, width: number): string[] {
  const text = (question.question ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width));
  if (wrapped.length <= MAX_HEADER_ROWS) return wrapped;
  const last = wrapped.slice(MAX_HEADER_ROWS - 1).join(" ");
  return [
    ...wrapped.slice(0, MAX_HEADER_ROWS - 1),
    truncateToWidth(last, Math.max(1, width), "\u2026"),
  ];
}

function tabLabel(question: AskQuestionItem, index: number): string {
  const base = question.header?.trim() || question.id || `Q${index + 1}`;
  return truncateToWidth(base.replace(/\s+/g, " "), MAX_TAB_LABEL_WIDTH, "\u2026");
}

/** Tab strip: one chip per question, plus Submit when the dialog cannot finish
 *  on a single answer (more than one question, or any multi-select). */
function tabStrip(questions: readonly AskQuestionItem[], active: number): string {
  const chips = questions.map((q, i) =>
    i === active ? `${BOLD}${CYAN}[${tabLabel(q, i)}]${RESET}` : dim(`[${tabLabel(q, i)}]`),
  );
  chips.push(
    active === questions.length
      ? `${BOLD}${CYAN}[${SUBMIT_LABEL}]${RESET}`
      : dim(`[${SUBMIT_LABEL}]`),
  );
  return ` ${chips.join(" ")}`;
}

export function hasSubmitTab(questions: readonly AskQuestionItem[]): boolean {
  return questions.length > 1 || questions.some((q) => q.multi === true);
}

function isAnswered(state: AskQuestionState): boolean {
  return state.freeText !== "" || state.selected.size > 0;
}

/** Human summary of one answered question, for the Submit review and for the
 *  transcript block after the fact. */
export function askAnswerSummary(question: AskQuestionItem, state: AskQuestionState): string {
  const labels = (question.options ?? [])
    .filter((o) => state.selected.has(o.value))
    .map((o) => o.label);
  if (question.multi === true) {
    const parts = [...labels];
    if (state.freeText) parts.push(`Other: \u201c${state.freeText}\u201d`);
    return parts.length > 0 ? parts.join(", ") : `${YELLOW}unanswered${RESET}`;
  }
  if (state.freeText) return `\u201c${state.freeText}\u201d`;
  if (labels.length > 0) return labels[0]!;
  return `${YELLOW}unanswered${RESET}`;
}

export function askResult(
  questions: readonly AskQuestionItem[],
  states: readonly AskQuestionState[],
): AskQuestionResult {
  return {
    answers: questions.map((q, i) => {
      const state = states[i]!;
      const answer: {
        id: string;
        selectedValues: string[];
        freeText?: string;
        note?: string;
        timedOut?: boolean;
      } = {
        id: q.id,
        selectedValues: q.kind === "text" ? [] : [...state.selected],
      };
      if (state.freeText) answer.freeText = state.freeText;
      if (state.note) answer.note = state.note;
      if (state.timedOut) answer.timedOut = true;
      return answer;
    }),
  };
}

export interface AskPanelOptions {
  /** Resolves the panel: the answers, or null when cancelled (the tool then
   *  fails closed). Called at most once. */
  onSettle(result: AskQuestionResult | null): void;
  requestRender(): void;
  /** Inactivity timeout (omp ask.timeout): the countdown restarts on every
   *  key, and on expiry the UNANSWERED questions take their recommended option
   *  and the ask submits with those answers marked `timedOut`. 0/absent = no
   *  timer, which is also oh-my-pi's default. */
  timeoutMs?: number;
}

export class AskPanel implements Component, Focusable {
  focused = false;
  private readonly questions: readonly AskQuestionItem[];
  private readonly states: AskQuestionState[];
  /** One buffer per question so a parked value survives tab switches. */
  private readonly fields: Input[];
  /** Notes need their own buffer: opening one must not clobber the answer. */
  private readonly noteFields: Input[];
  private tab = 0;
  /** The field owning input right now: which question, which of its rows
   *  (`TEXT_ROW` = the question's own field, else the Other row's index), and
   *  whether it is editing the answer or a note on that row. */
  private open: { index: number; row: number; mode: "answer" | "note" } | null = null;
  private viewportRows = 24;
  private submitScroll = 0;
  private settled = false;
  /** Height memo: the box must not resize on cursor moves or typing. */
  private heightMemo: { key: string; rows: number } | undefined;
  private readonly timeoutMs: number;
  private deadline?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private remainingSec = 0;
  /** The timer fired while a field was open: run it once the field closes
   *  (oh-my-pi defers the same way, so a half-typed answer is never yanked). */
  private timeoutPending = false;

  constructor(
    input: AskQuestionInput,
    private readonly options: AskPanelOptions,
  ) {
    this.questions = input.questions;
    this.states = createAskQuestionStates(this.questions);
    this.fields = this.questions.map(() => {
      const field = new Input();
      // Input reports enter/escape back to the panel: the field is a buffer,
      // the panel owns the semantics.
      field.onSubmit = () => this.commitField();
      field.onEscape = () => this.leaveField();
      return field;
    });
    this.noteFields = this.questions.map(() => {
      const field = new Input();
      field.onSubmit = () => this.commitNote();
      field.onEscape = () => this.leaveNote();
      return field;
    });
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0;
    // A text question has no rows to navigate: its field is the only surface,
    // so it owns input from the moment its tab is shown.
    if (this.questions[0]?.kind === "text") this.openField(0, TEXT_ROW);
    this.armTimers();
  }

  /** The frame provider owns the viewport size; the panel only reads it. */
  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, rows);
  }

  invalidate(): void {
    // Nothing cached beyond the height memo, which is keyed by width+viewport.
  }

  handleInput(data: string): void {
    if (this.settled) return;
    // Any key restarts the inactivity countdown, matching oh-my-pi.
    this.armTimers();
    if (this.open?.mode === "note") {
      this.noteFields[this.open.index]!.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (this.open) {
      // Tab is the dialog's, not the field's: Input would swallow it and a
      // text question would capture tab navigation for the rest of the ask.
      // Committing here keeps the buffer as the answer (form-style Tab).
      if (matchesKey(data, "tab")) {
        this.commitField(false);
        this.moveTab(1);
        return;
      }
      // Otherwise the field owns every key; Input reports enter and escape
      // back through onSubmit/onEscape.
      this.fields[this.open.index]!.handleInput(data);
      this.options.requestRender();
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (this.atSubmit()) {
      this.handleSubmitInput(data, kb);
      this.options.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.scrollBody(-1);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.scrollBody(1);
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.moveCursor(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.moveTab(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.moveTab(-1);
      return;
    }

    const question = this.activeQuestion();
    const state = this.activeState();
    if (!question || !state) return;
    const row = askRows(question)[state.cursor];
    if (!row) return;
    // `n` attaches a note to the focused row (oh-my-pi's note key), for options
    // and the Other row alike. Matched as a raw character: a terminal sends
    // "N" for shift+n and the key parser maps plain letters to themselves.
    if (data === "n" || data === "N") {
      this.openNote(this.tab, state.cursor);
      return;
    }
    if (row.kind === "other") {
      // Enter/Space opens the field; Enter INSIDE it commits the value.
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        this.openField(this.tab, state.cursor);
        this.options.requestRender();
      }
      return;
    }
    if (question.multi === true) {
      // Space toggles, Enter advances — the split implied by the multi-select
      // contract (and by oh-my-pi's dialog): Enter must not mean two different
      // things in the two modes.
      if (matchesKey(data, "space")) {
        this.toggleOption(this.tab, row.value);
        return;
      }
      if (matchesKey(data, "enter")) this.advance();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.pickExclusive(this.tab, row.value);
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const header = this.headerLines(contentWidth);
    const total = this.dialogHeight(contentWidth);
    const bodyRows = Math.max(MIN_BODY_ROWS, total - header.length - 5);
    const body = this.atSubmit()
      ? this.submitBody(contentWidth, bodyRows)
      : this.questionBody(contentWidth, bodyRows);
    return renderOutputBlock({
      header: `${CYAN}${this.titleText()}${RESET}`,
      headerMeta: this.headerMeta(),
      state: "running",
      borderColor: CYAN,
      sections: [
        // Every line is pre-truncated to the inner width: the frame wraps what
        // it is given, and a wrapped line would break the body's 1:1 line
        // windowing (see renderAskRows).
        { lines: header.map((l) => truncateToWidth(l, contentWidth, "\u2026")) },
        { separator: true, lines: body.lines },
        {
          separator: true,
          lines: [` ${truncateToWidth(this.footer(body.indicator), contentWidth - 1, "\u2026")}`],
        },
      ],
      width,
    });
  }

  private titleText(): string {
    return this.timeoutMs > 0 ? `Ask (${this.remainingSec}s)` : "Ask";
  }

  /** Size the box from the tallest question, clamped to the viewport ratio.
   *  Derived from questions + viewport only — never from cursor/tab/answer
   *  state — so the panel stays put for its whole lifetime. */
  private dialogHeight(width: number): number {
    const key = `${width}:${this.viewportRows}`;
    if (this.heightMemo?.key === key) return this.heightMemo.rows;
    const maxHeight = Math.max(
      MIN_DIALOG_ROWS,
      Math.floor(this.viewportRows * DIALOG_HEIGHT_RATIO),
    );
    const tabs = hasSubmitTab(this.questions) ? 1 : 0;
    let needed = MIN_DIALOG_ROWS;
    for (let i = 0; i < this.questions.length; i++) {
      const question = this.questions[i]!;
      const head = tabs + questionTitleLines(question, width).length;
      const body =
        question.kind === "text"
          ? 2
          : renderAskRows(question, this.states[i]!, width, undefined).lines.length;
      needed = Math.max(needed, head + Math.max(MIN_BODY_ROWS, body) + 5);
    }
    if (hasSubmitTab(this.questions)) {
      // Warning line + blank + one summary line per question + blank + Submit.
      needed = Math.max(needed, tabs + Math.max(MIN_BODY_ROWS, this.questions.length + 4) + 5);
    }
    const rows = Math.min(needed, maxHeight);
    this.heightMemo = { key, rows };
    return rows;
  }

  private headerLines(width: number): string[] {
    const lines: string[] = [];
    if (hasSubmitTab(this.questions)) lines.push(tabStrip(this.questions, this.tab));
    if (this.atSubmit()) {
      lines.push(`${BOLD}${CYAN} Review answers${RESET}`);
      return lines;
    }
    const question = this.activeQuestion();
    if (!question) return lines;
    // -1: the title lines are indented by one column below.
    for (const line of questionTitleLines(question, width - 1)) lines.push(` ${line}`);
    return lines;
  }

  private headerMeta(): string | undefined {
    const count = this.questions.length;
    const parts = [`${count} question${count === 1 ? "" : "s"}`];
    if (this.questions.some((q) => q.multi === true)) parts.push("multi");
    return parts.join(" \u00b7 ");
  }

  private questionBody(width: number, rows: number): { lines: string[]; indicator: string } {
    const question = this.activeQuestion();
    const state = this.activeState();
    if (!question || !state) return { lines: pad([], rows, width), indicator: "" };
    const openHere = this.open?.index === this.tab ? this.open : undefined;
    if (question.kind === "text") {
      const field = this.fields[this.tab]!;
      const open = openHere?.mode === "answer";
      return {
        lines: pad(
          [
            fieldLine(
              field,
              width,
              open,
              state.freeText,
              question.placeholder?.trim() || "type your answer, Enter to continue",
            ),
          ],
          rows,
          width,
        ),
        indicator: "",
      };
    }
    const rendered = renderAskRows(
      question,
      state,
      width,
      openHere
        ? {
            row: openHere.row,
            field: openHere.mode === "note" ? this.noteFields[this.tab]! : this.fields[this.tab]!,
            mode: openHere.mode,
          }
        : undefined,
    );
    const cursorStart = rendered.lineStart[state.cursor] ?? 0;
    const cursorEnd = rendered.lineStart[state.cursor + 1] ?? rendered.lines.length;
    state.scroll = clampScroll(state.scroll, cursorStart, cursorEnd, rows, rendered.lines.length);
    return {
      lines: pad(rendered.lines.slice(state.scroll, state.scroll + rows), rows, width),
      indicator: this.indicator(state.scroll, rows, rendered.lines.length),
    };
  }

  private submitBody(width: number, rows: number): { lines: string[]; indicator: string } {
    const all: string[] = [];
    const unanswered = this.questions.filter((_, i) => !isAnswered(this.states[i]!)).length;
    if (unanswered > 0) {
      all.push(
        `${YELLOW} ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}; Enter still submits.${RESET}`,
      );
      all.push("");
    }
    for (let i = 0; i < this.questions.length; i++) {
      const question = this.questions[i]!;
      const state = this.states[i]!;
      const summary = askAnswerSummary(question, state);
      all.push(` ${dim(`${i + 1}. ${tabLabel(question, i)}:`)} ${summary}`);
      // The note is attached evidence — it belongs with the answer it annotates.
      if (state.note) all.push(`    ${dim("Note:")} ${state.note}`);
    }
    all.push("");
    all.push(` ${accent(`\u2192 ${SUBMIT_LABEL}`)}`);
    this.submitScroll = Math.max(0, Math.min(this.submitScroll, Math.max(0, all.length - rows)));
    const window = all.slice(this.submitScroll, this.submitScroll + rows);
    return {
      lines: pad(window, rows, width),
      indicator: this.indicator(this.submitScroll, rows, all.length),
    };
  }

  private footer(indicator: string): string {
    if (this.open?.mode === "note") return dim("Enter save note \u00b7 Esc back");
    if (this.open) return dim("Enter confirm \u00b7 Esc back");
    const scroll = indicator ? ` ${indicator} scroll` : "";
    if (this.atSubmit()) {
      return dim(`Enter submit \u00b7 \u2191/\u2193 scroll${scroll} \u00b7 Esc cancel`);
    }
    const question = this.activeQuestion();
    const tabs = hasSubmitTab(this.questions) ? " \u00b7 Tab/\u2190/\u2192 switch" : "";
    const action = question?.multi === true ? "Space toggle \u00b7 Enter next" : "Enter select";
    return dim(
      `${action} \u00b7 \u2191/\u2193 move \u00b7 n note${tabs}${scroll} \u00b7 Esc cancel`,
    );
  }

  private indicator(offset: number, rows: number, total: number): string {
    const above = offset > 0;
    const below = offset + rows < total;
    if (above && below) return "\u2195";
    if (above) return "\u2191";
    if (below) return "\u2193";
    return "";
  }

  private atSubmit(): boolean {
    return hasSubmitTab(this.questions) && this.tab === this.questions.length;
  }

  private activeQuestion(): AskQuestionItem | undefined {
    return this.atSubmit() ? undefined : this.questions[this.tab];
  }

  private activeState(): AskQuestionState | undefined {
    return this.atSubmit() ? undefined : this.states[this.tab];
  }

  /** Tabs WRAP (oh-my-pi's #switchTab is modular): Tab from Submit returns to
   *  the first question, and ← from the first lands on Submit. */
  private moveTab(delta: number): void {
    const count = hasSubmitTab(this.questions) ? this.questions.length + 1 : this.questions.length;
    if (count === 0) return;
    const next = (this.tab + delta + count) % count;
    if (next === this.tab) return;
    this.tab = next;
    if (this.questions[next]?.kind === "text") this.openField(next, TEXT_ROW);
    else this.closeField();
    this.submitScroll = 0;
    this.options.requestRender();
  }

  private moveCursor(delta: number): void {
    const question = this.activeQuestion();
    const state = this.activeState();
    if (!question || !state) return;
    const count = askRows(question).length;
    state.cursor = Math.max(0, Math.min(count - 1, state.cursor + delta));
    this.options.requestRender();
  }

  private scrollBody(direction: 1 | -1): void {
    if (this.atSubmit()) {
      this.submitScroll = Math.max(0, this.submitScroll + direction * PAGE_ROWS);
    } else {
      const state = this.activeState();
      if (!state) return;
      state.scroll = Math.max(0, state.scroll + direction * PAGE_ROWS);
    }
    this.options.requestRender();
  }

  private handleSubmitInput(data: string, kb: KeybindingsManager): void {
    if (matchesKey(data, "enter")) {
      this.settle();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) this.moveTab(1);
    else if (matchesKey(data, "left")) this.moveTab(-1);
    else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.up")) {
      this.scrollBody(-1);
    } else if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.select.down")) {
      this.scrollBody(1);
    }
  }

  /** Enter on a question: submit when this answer IS the whole dialog, else
   *  walk to the next tab (Submit is the last one). */
  private advance(): void {
    if (!hasSubmitTab(this.questions)) {
      this.settle();
      return;
    }
    this.moveTab(1);
  }

  private toggleOption(index: number, value: string): void {
    const state = this.states[index]!;
    if (state.selected.has(value)) {
      state.selected.delete(value);
      // The note belonged to that selection (oh-my-pi clears it the same way).
      this.clearNoteIfRow(
        index,
        askRows(this.questions[index]!).findIndex((r) => r.value === value),
      );
    } else {
      state.selected.add(value);
      this.clearFreeText(index);
    }
    this.options.requestRender();
  }

  private pickExclusive(index: number, value: string): void {
    const state = this.states[index]!;
    const row = askRows(this.questions[index]!).findIndex((r) => r.value === value);
    // A note on a DIFFERENT row is dropped: it annotated a choice that is no
    // longer the answer.
    if (state.noteRow !== row) this.dropNote(index);
    state.selected.clear();
    state.selected.add(value);
    this.clearFreeText(index);
    this.advance();
  }

  /** An option pick and an Other free-text answer are alternatives: choosing
   *  one drops the other (both the value and its buffer). */
  private clearFreeText(index: number): void {
    this.states[index]!.freeText = "";
    this.fields[index]!.setValue("");
  }

  private clearNoteIfRow(index: number, row: number): void {
    if (this.states[index]!.noteRow === row) this.dropNote(index);
  }

  private dropNote(index: number): void {
    const state = this.states[index]!;
    state.note = "";
    state.noteRow = null;
    this.noteFields[index]!.setValue("");
  }

  /** Open a question's answer field, seeded with its committed value so
   *  re-editing continues from what the user typed rather than from empty. */
  private openField(index: number, row: number): void {
    this.fields[index]!.setValue(this.states[index]?.freeText ?? "");
    this.open = { index, row, mode: "answer" };
    this.syncFieldFocus(index, this.fields[index]!);
  }

  /** Open the note field for a row (oh-my-pi's `n`), seeded with that row's
   *  existing note. */
  private openNote(index: number, row: number): void {
    const state = this.states[index]!;
    const existing = state.noteRow === row ? state.note : "";
    this.noteFields[index]!.setValue(existing);
    this.open = { index, row, mode: "note" };
    this.syncFieldFocus(index, this.noteFields[index]!);
    this.options.requestRender();
  }

  private syncFieldFocus(index: number, focused: Input): void {
    for (let i = 0; i < this.fields.length; i++) {
      this.fields[i]!.focused = i === index && this.fields[i] === focused;
      this.noteFields[i]!.focused = i === index && this.noteFields[i] === focused;
    }
  }

  private closeField(): void {
    this.open = null;
    for (const field of this.fields) field.focused = false;
    for (const field of this.noteFields) field.focused = false;
  }

  /** Enter inside an ANSWER field. For a text question that IS the answer, so
   *  it advances; so does an Other value on a pick-one question. On a pick-many
   *  question it only commits (the same Enter/Space split as a toggle). */
  private commitField(advance = true): void {
    const open = this.open;
    if (open?.mode !== "answer") return;
    const question = this.questions[open.index]!;
    const state = this.states[open.index]!;
    state.freeText = this.fields[open.index]!.getValue().trim();
    if (state.freeText !== "" && question.multi !== true) {
      // A free-text answer replaces the picked option (they are alternatives).
      state.selected.clear();
      if (state.noteRow !== null && state.noteRow !== this.otherRow(question))
        this.dropNote(open.index);
    }
    this.closeField();
    this.options.requestRender();
    if (advance && (question.kind === "text" || question.multi !== true)) this.advance();
    else this.flushPendingTimeout();
  }

  private otherRow(question: AskQuestionItem): number {
    return askRows(question).findIndex((r) => r.kind === "other");
  }

  /** Enter inside a NOTE field: the note belongs to the row it was opened on
   *  (an empty value clears it). */
  private commitNote(): void {
    const open = this.open;
    if (open?.mode !== "note") return;
    const state = this.states[open.index]!;
    const value = this.noteFields[open.index]!.getValue().trim();
    state.note = value;
    state.noteRow = value === "" ? null : open.row;
    this.closeField();
    this.options.requestRender();
    this.flushPendingTimeout();
  }

  /** Esc inside an ANSWER field: back out to the row list. A text question has
   *  no row list, so backing out of it means backing out of the ask. */
  private leaveField(): void {
    const open = this.open;
    if (open?.mode !== "answer") return;
    if (this.questions[open.index]?.kind === "text") {
      this.cancel();
      return;
    }
    this.fields[open.index]!.setValue(this.states[open.index]!.freeText);
    this.closeField();
    this.options.requestRender();
    this.flushPendingTimeout();
  }

  /** Esc inside a NOTE field keeps whatever note was there — an abandoned edit
   *  is not a deletion (oh-my-pi's note prompt behaves the same way). */
  private leaveNote(): void {
    const open = this.open;
    if (open?.mode !== "note") return;
    this.noteFields[open.index]!.setValue(this.states[open.index]!.note);
    this.closeField();
    this.options.requestRender();
    this.flushPendingTimeout();
  }

  // ── Timeout (omp ask.timeout) ─────────────────────────────────────────────

  /** (Re)arm the inactivity countdown. Called on every key, so an engaged user
   *  never times out; an abandoned dialog does. */
  private armTimers(): void {
    if (this.timeoutMs <= 0 || this.settled) return;
    this.clearTimers();
    this.remainingSec = Math.ceil(this.timeoutMs / 1000);
    // unref: a pending ask must never hold the process open by itself.
    this.deadline = setTimeout(() => this.expire(), this.timeoutMs);
    this.deadline.unref?.();
    this.ticker = setInterval(() => {
      if (this.remainingSec > 0) this.remainingSec -= 1;
      this.options.requestRender();
    }, 1_000);
    this.ticker.unref?.();
  }

  private clearTimers(): void {
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.deadline = undefined;
    this.ticker = undefined;
  }

  private flushPendingTimeout(): void {
    if (!this.timeoutPending) return;
    this.timeoutPending = false;
    this.expire();
  }

  /** On expiry, every UNANSWERED question takes its recommended option (or the
   *  row the user was focused on when they wrote a note) and is marked
   *  `timedOut`: the model must be able to tell an auto-selection from consent.
   *  Then the ask submits, answered or not. */
  private expire(): void {
    if (this.settled) return;
    if (this.open) {
      // Never yank a field mid-edit; run once it closes (oh-my-pi defers too).
      this.timeoutPending = true;
      return;
    }
    for (let i = 0; i < this.questions.length; i++) {
      const question = this.questions[i]!;
      const state = this.states[i]!;
      if (isAnswered(state)) continue;
      const rows = askRows(question);
      const recommended = rows.findIndex(
        (r) => r.kind === "option" && r.value === question.recommended,
      );
      const noted = state.noteRow !== null ? rows[state.noteRow] : undefined;
      const index = noted?.kind === "option" ? state.noteRow! : recommended >= 0 ? recommended : 0;
      const row = rows[index];
      if (row?.kind !== "option") continue;
      state.selected.add(row.value);
      state.timedOut = true;
    }
    this.settle();
  }

  private cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.options.onSettle(null);
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.options.onSettle(askResult(this.questions, this.states));
  }
}

function clampScroll(
  current: number,
  cursorStart: number,
  cursorEnd: number,
  rows: number,
  total: number,
): number {
  const maxOffset = Math.max(0, total - rows);
  if (maxOffset === 0) return 0;
  const next = Math.max(0, Math.min(current, maxOffset));
  // A row's own lines stay together: scrolling must not expose a neighbour
  // while Enter still targets this row.
  if (cursorStart < next || cursorEnd > next + rows) {
    const height = cursorEnd - cursorStart;
    return Math.max(0, Math.min(height <= rows ? cursorEnd - rows : cursorStart, maxOffset));
  }
  return next;
}

/** Window the body to exactly `rows` lines, truncating any line that would
 *  otherwise be wrapped by the frame (which would add a line the window does
 *  not know about). */
function pad(lines: readonly string[], rows: number, width: number): string[] {
  const out = lines.slice(0, rows).map((line) => truncateToWidth(line, width, "\u2026"));
  while (out.length < rows) out.push("");
  return out;
}
