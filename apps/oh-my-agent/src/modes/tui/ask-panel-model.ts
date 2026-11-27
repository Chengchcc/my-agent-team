import type { AskQuestionItem, AskQuestionResult } from "@chengchenccc/message";
import {
  type Input,
  Markdown,
  truncateToWidth,
  tuiTheme,
  wrapTextWithAnsi,
} from "@chengchenccc/tui";
import { MARKDOWN_THEME } from "./tui-format.js";

/** Fraction of the viewport the panel may occupy. */
export const DIALOG_HEIGHT_RATIO = 0.7;
export const MIN_DIALOG_ROWS = 12;
export const MIN_BODY_ROWS = 3;
/** A long/multi-line question must not push the option list off-screen. */
const MAX_HEADER_ROWS = 4;
const MAX_DESCRIPTION_ROWS = 2;
const MAX_TAB_LABEL_WIDTH = 16;
export const PAGE_ROWS = 5;
/** Cap on the preview render cache. */
const PREVIEW_CACHE_MAX = 64;

const OTHER_LABEL = "Other (type your own)";
export const SUBMIT_LABEL = "Submit";
/** Row index meaning "this field belongs to the whole question", i.e. a
 *  `kind:"text"` question rather than one option row. */
export const TEXT_ROW = -1;

export const BOLD = "\u001b[1m";
export const DIM = tuiTheme.dim;
export const CYAN = tuiTheme.accent;
export const GREEN = tuiTheme.success;
export const YELLOW = tuiTheme.warning;
export const RESET = "\u001b[0m";

export const dim = (s: string): string => `${DIM}${s}${RESET}`;
export const accent = (s: string): string => `${CYAN}${s}${RESET}`;

/** One selectable row of a question body. */
export type AskRow =
  | { kind: "option"; value: string; label: string; description?: string; preview?: string }
  | { kind: "other"; value: undefined; label: string };

/** Committed answer state per question. */
export interface AskQuestionState {
  readonly selected: Set<string>;
  freeText: string;
  note: string;
  noteRow: number | null;
  cursor: number;
  scroll: number;
  timedOut: boolean;
}

export function createAskQuestionStates(questions: readonly AskQuestionItem[]): AskQuestionState[] {
  return questions.map((q) => {
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

function marker(multi: boolean, checked: boolean): string {
  if (multi) return checked ? "\u2611" : "\u2610";
  return checked ? "\u25c9" : "\u25cb";
}

function optionLabel(question: AskQuestionItem, index: number): string {
  const option = question.options?.[index];
  if (!option) return "";
  return question.recommended === option.value && !option.label.includes("(Recommended)")
    ? `${option.label} (Recommended)`
    : option.label;
}

function renderField(field: Input, width: number): string {
  const [line = ""] = field.render(Math.max(3, width + 2));
  return line.slice(2);
}

export function fieldLine(
  field: Input,
  width: number,
  open: boolean,
  value: string,
  placeholder: string,
): string {
  if (!open) return truncateToWidth(`\u258f${value}`, width, "\u2026");
  const rendered = renderField(field, Math.max(1, width - 2));
  if (field.getValue() !== "") return `\u258f${rendered}`;
  const cursor = rendered.replace(/\s+$/, "");
  return truncateToWidth(`\u258f${cursor}${dim(`  \u2014 ${placeholder}`)}`, width, "\u2026");
}

const previewCache = new Map<string, Markdown>();

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

export function questionTitleLines(question: AskQuestionItem, width: number): string[] {
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

export function tabLabel(question: AskQuestionItem, index: number): string {
  const base = question.header?.trim() || question.id || `Q${index + 1}`;
  return truncateToWidth(base.replace(/\s+/g, " "), MAX_TAB_LABEL_WIDTH, "\u2026");
}

export function tabStrip(questions: readonly AskQuestionItem[], active: number): string {
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

export function isAnswered(state: AskQuestionState): boolean {
  return state.freeText !== "" || state.selected.size > 0;
}

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

export function clampScroll(
  current: number,
  cursorStart: number,
  cursorEnd: number,
  rows: number,
  total: number,
): number {
  const maxOffset = Math.max(0, total - rows);
  if (maxOffset === 0) return 0;
  const next = Math.max(0, Math.min(current, maxOffset));
  if (cursorStart < next || cursorEnd > next + rows) {
    const height = cursorEnd - cursorStart;
    return Math.max(0, Math.min(height <= rows ? cursorEnd - rows : cursorStart, maxOffset));
  }
  return next;
}

export function pad(lines: readonly string[], rows: number, width: number): string[] {
  const out = lines.slice(0, rows).map((line) => truncateToWidth(line, width, "\u2026"));
  while (out.length < rows) out.push("");
  return out;
}
