import type { AskQuestionInput, AskQuestionItem, AskQuestionResult } from "@chengchenccc/message";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  type KeybindingsManager,
  matchesKey,
  renderOutputBlock,
  truncateToWidth,
} from "@chengchenccc/tui";
import {
  type AskQuestionState,
  accent,
  askAnswerSummary,
  askResult,
  askRows,
  BOLD,
  CYAN,
  clampScroll,
  createAskQuestionStates,
  DIALOG_HEIGHT_RATIO,
  dim,
  fieldLine,
  hasSubmitTab,
  isAnswered,
  MIN_BODY_ROWS,
  MIN_DIALOG_ROWS,
  PAGE_ROWS,
  pad,
  questionTitleLines,
  RESET,
  renderAskRows,
  SUBMIT_LABEL,
  TEXT_ROW,
  tabLabel,
  tabStrip,
  YELLOW,
} from "./ask-panel-model.js";

export {
  type AskQuestionState,
  askAnswerSummary,
  askResult,
  askRows,
  createAskQuestionStates,
  hasSubmitTab,
  renderAskRows,
};

/** The HITL ask surface (ask_question). DOCKED, not floating: it takes over
 *  the editor slot at the bottom of the screen and grows upward. Pure state
 *  and row-rendering helpers live in `./ask-panel-model.ts`. */

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
      // Multi-select keeps any user-typed "Other" freeText alongside checked options;
      // only single-select (`pickExclusive`) clears freeText.
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
  /** Stop timers without triggering onSettle (used on external dismiss/close). */
  dispose(): void {
    this.settled = true;
    this.clearTimers();
  }

  private expire(): void {
    if (this.settled) return;
    if (this.open) {
      // Never yank a field mid-edit; stop the 1s countdown ticker immediately
      // and run expiry once the field closes (oh-my-pi defers too).
      this.clearTimers();
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
