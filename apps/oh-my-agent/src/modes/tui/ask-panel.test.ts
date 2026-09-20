import { describe, expect, test } from "bun:test";
import type { AskQuestionInput, AskQuestionItem } from "@chengchenccc/agent-contract";
import {
  AskPanel,
  askAnswerSummary,
  askResult,
  askRows,
  createAskQuestionStates,
  hasSubmitTab,
  renderAskRows,
} from "./ask-panel.js";

/** Strip SGR codes: the panel colours markers/labels, and a test asserting on
 *  rendered text should not depend on where a colour escape lands. Built from
 *  a char code — a literal ESC in a regex is a lint error. */
const ANSI_STRIP = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_STRIP, "");

const ENTER = "\r";
const ESC = "\u001b";
const SPACE = " ";
const DOWN = "\u001b[B";
const TAB = "\t";

const select = (over: Partial<AskQuestionItem> = {}): AskQuestionItem => ({
  id: "q1",
  kind: "select",
  question: "Which one?",
  options: [
    { value: "a", label: "alpha", description: "first" },
    { value: "b", label: "beta" },
  ],
  ...over,
});

const text = (over: Partial<AskQuestionItem> = {}): AskQuestionItem => ({
  id: "q2",
  kind: "text",
  question: "Anything else?",
  ...over,
});

function panel(
  questions: AskQuestionItem[],
  opts: { timeoutMs?: number } = {},
): {
  panel: AskPanel;
  settled: Array<unknown>;
  type: (s: string) => void;
} {
  const settled: Array<unknown> = [];
  const created = new AskPanel({ questions } as AskQuestionInput, {
    onSettle: (result) => settled.push(result),
    requestRender: () => {},
    ...opts,
  });
  created.setViewportRows(30);
  return {
    panel: created,
    settled,
    // One key at a time: printable text arrives per character, like a terminal.
    type: (s: string) => {
      for (const ch of s) created.handleInput(ch);
    },
  };
}

describe("askRows (what the cursor can land on)", () => {
  test("options then an Other row — shown by default so a model cannot trap the user", () => {
    const rows = askRows(select());
    expect(rows.map((r) => r.kind)).toEqual(["option", "option", "other"]);
    expect(askRows(select({ allowOther: false })).map((r) => r.kind)).toEqual(["option", "option"]);
  });

  test("a text question has no option rows and no Other row (its field IS the row)", () => {
    expect(askRows(text())).toEqual([]);
  });
});

describe("renderAskRows (markers, labels, line mapping)", () => {
  test("radio for pick-one, checkbox for pick-many; the cursor marks the focused row", () => {
    const question = select();
    const single = createAskQuestionStates([question])[0]!;
    const one = renderAskRows(question, single, 40, undefined);
    expect(plain(one.lines[0]!)).toBe("\u2192 \u25cb alpha");
    expect(plain(one.lines[1]!)).toContain("\u21b3 first"); // description on its own line

    const multi = { ...question, multi: true };
    const many = createAskQuestionStates([multi])[0]!;
    expect(plain(renderAskRows(multi, many, 40, undefined).lines[0]!)).toBe("\u2192 \u2610 alpha");
  });

  test("a selected option fills its marker and the recommended one is badged", () => {
    const question = select({ recommended: "b" });
    const state = createAskQuestionStates([question])[0]!;
    state.selected.add("b");
    const { lines } = renderAskRows(question, state, 40, undefined);
    expect(plain(lines[0]!)).toContain("\u25cb alpha");
    expect(plain(lines[2]!)).toContain("\u25c9 beta (Recommended)");
  });

  test("lineStart maps every row to its first line, including a multi-line description", () => {
    const question = select();
    const state = createAskQuestionStates([question])[0]!;
    const { lines, lineStart } = renderAskRows(question, state, 40, undefined);
    // row0: label + description, row1: label, row2: Other (+ the end marker).
    expect(lineStart).toEqual([0, 2, 3, 4]);
    expect(lines.length).toBe(4);
  });

  test("rows never exceed the given width (the body windows lines 1:1)", () => {
    const question = select({
      question: "long",
      options: [{ value: "a", label: "x".repeat(200) }],
    });
    const state = createAskQuestionStates([question])[0]!;
    const { lines } = renderAskRows(question, state, 30, undefined);
    for (const line of lines) expect(plain(line).length).toBeLessThanOrEqual(30);
  });
});

describe("AskPanel: pick-one", () => {
  test("Enter picks the focused option and settles immediately for a single question", () => {
    const { panel: p, settled } = panel([select()]);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["a"] }] }]);
  });

  test("arrow down then Enter picks the second option", () => {
    const { panel: p, settled } = panel([select()]);
    p.handleInput(DOWN);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["b"] }] }]);
  });

  test("Esc settles null — the tool then fails closed", () => {
    const { panel: p, settled } = panel([select()]);
    p.handleInput(ESC);
    expect(settled).toEqual([null]);
  });

  test("settles at most once (a late key cannot answer twice)", () => {
    const { panel: p, settled } = panel([select()]);
    p.handleInput(ENTER);
    p.handleInput(ENTER);
    p.handleInput(ESC);
    expect(settled).toHaveLength(1);
  });
});

describe("AskPanel: multi-select", () => {
  const multiQuestions = [select({ multi: true })];

  test("Space toggles and does NOT settle; Enter advances to the Submit tab", () => {
    const { panel: p, settled } = panel(multiQuestions);
    p.handleInput(SPACE);
    expect(settled).toHaveLength(0);
    p.handleInput(DOWN);
    p.handleInput(SPACE);
    p.handleInput(ENTER);
    expect(settled).toHaveLength(0);
    // On the Submit tab Enter submits the accumulated set.
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["a", "b"] }] }]);
  });

  test("Space on a selected option deselects it", () => {
    const { panel: p, settled } = panel(multiQuestions);
    p.handleInput(SPACE);
    p.handleInput(SPACE);
    p.handleInput(ENTER);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: [] }] }]);
  });

  test("the multi question forces a Submit tab (review before submit)", () => {
    expect(hasSubmitTab(multiQuestions)).toBe(true);
    expect(hasSubmitTab([select()])).toBe(false);
  });
});

describe("AskPanel: free text and the Other row", () => {
  test("a text question owns input immediately: typing then Enter settles with freeText", () => {
    const { panel: p, settled, type } = panel([text()]);
    type("typed answer");
    p.handleInput(ENTER);
    expect(settled).toEqual([
      { answers: [{ id: "q2", selectedValues: [], freeText: "typed answer" }] },
    ]);
  });

  test("Tab leaves an open field instead of being swallowed by it", () => {
    // A text question opens its field immediately; if the Input owned Tab, the
    // dialog's tab navigation would be unreachable from that question.
    const { panel: p, settled, type } = panel([text(), select()]);
    type("first answer");
    p.handleInput(TAB);
    // Tab committed the buffer and moved to the next question (no settle: the
    // select question still needs an answer, then the Submit tab confirms).
    expect(settled).toHaveLength(0);
    p.handleInput(ENTER);
    expect(settled).toHaveLength(0);
    p.handleInput(ENTER);
    expect(settled).toEqual([
      {
        answers: [
          { id: "q2", selectedValues: [], freeText: "first answer" },
          { id: "q1", selectedValues: ["a"] },
        ],
      },
    ]);
  });

  test("Enter on the Other row opens a field; the committed value is the answer", () => {
    const { panel: p, settled, type } = panel([select()]);
    p.handleInput(DOWN);
    p.handleInput(DOWN); // the Other row
    p.handleInput(ENTER); // opens the field — it does not settle by itself
    expect(settled).toHaveLength(0);
    type("neither");
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: [], freeText: "neither" }] }]);
  });

  test("a pick-one answer carries the option value, not the label", () => {
    // The contract's selectedValues are option VALUES; the panel renders
    // labels, so the two must not be conflated.
    const { panel: p, settled } = panel([
      select({ options: [{ value: "v1", label: "A friendly label" }] }),
    ]);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["v1"] }] }]);
  });

  test("Esc inside an Other field backs out to the row list, not out of the ask", () => {
    const { panel: p, settled, type } = panel([select()]);
    p.handleInput(DOWN);
    p.handleInput(DOWN);
    p.handleInput(ENTER);
    type("half typed");
    p.handleInput(ESC);
    expect(settled).toHaveLength(0);
    // Back on the rows: Enter now picks the focused (Other) row's value again.
    p.handleInput(ESC);
    expect(settled).toEqual([null]);
  });

  test("Esc inside a TEXT field cancels the ask (no row list to fall back to)", () => {
    const { panel: p, settled } = panel([text()]);
    p.handleInput(ESC);
    expect(settled).toEqual([null]);
  });
});

describe("AskPanel: multiple questions", () => {
  const questions = [select(), text()];

  test("Enter on the first question advances instead of settling; Submit settles", () => {
    const { panel: p, settled, type } = panel(questions);
    p.handleInput(ENTER);
    expect(settled).toHaveLength(0);
    type("second answer");
    p.handleInput(ENTER);
    expect(settled).toHaveLength(0);
    p.handleInput(ENTER); // Submit tab
    expect(settled).toEqual([
      {
        answers: [
          { id: "q1", selectedValues: ["a"] },
          { id: "q2", selectedValues: [], freeText: "second answer" },
        ],
      },
    ]);
  });

  test("Tab walks the tabs and the render keeps a stable height across them", () => {
    const { panel: p } = panel(questions);
    const first = p.render(80);
    p.handleInput(TAB);
    const second = p.render(80);
    p.handleInput(TAB);
    const submit = p.render(80);
    // The box must not resize on a tab switch: cursor moves and typing would
    // otherwise make the whole panel jump.
    expect(second.length).toBe(first.length);
    expect(submit.length).toBe(first.length);
    expect(submit.join("\n")).toContain("Review answers");
  });
});

describe("AskPanel: rendering", () => {
  test("the frame names the dialog and carries the tab strip", () => {
    const { panel: p } = panel([select({ header: "Rendering" }), text({ header: "Notes" })]);
    const screen = p.render(100).join("\n");
    expect(screen).toContain("Ask");
    expect(screen).toContain("2 questions");
    expect(screen).toContain("[Rendering]");
    expect(screen).toContain("[Submit]");
    expect(screen).toContain("Which one?");
  });

  test("the panel clamps itself to 70% of the viewport", () => {
    const { panel: p } = panel([select()]);
    p.setViewportRows(30);
    expect(p.render(100).length).toBeLessThanOrEqual(21);
    p.setViewportRows(12);
    expect(p.render(100).length).toBeLessThanOrEqual(12);
  });

  test("an open field renders the hardware cursor marker (the TUI reads it)", () => {
    const { panel: p, type } = panel([text()]);
    type("abc");
    const line = p.render(60).find((l) => l.includes("abc"));
    expect(line).toBeDefined();
    // reverse-video cursor from Input; the marker is stripped by the TUI.
    expect(line).toContain(`${String.fromCharCode(27)}[7m`);
  });

  test("a cancelled ask reports every question as cancelled", () => {
    const question = select();
    const state = createAskQuestionStates([question])[0]!;
    // Nothing selected: the transcript summary says so rather than pretending.
    expect(askAnswerSummary(question, state)).toContain("unanswered");
    state.selected.add("b");
    expect(askAnswerSummary(question, state)).toBe("beta");
    state.selected.clear();
    state.freeText = "custom";
    expect(askAnswerSummary(question, state)).toBe("\u201ccustom\u201d");
  });
});

describe("askResult", () => {
  test("maps committed state onto the contract, free text included", () => {
    const questions = [select(), text()];
    const states = createAskQuestionStates(questions);
    states[0]!.selected.add("b");
    states[1]!.freeText = "note";
    expect(askResult(questions, states)).toEqual({
      answers: [
        { id: "q1", selectedValues: ["b"] },
        { id: "q2", selectedValues: [], freeText: "note" },
      ],
    });
  });
});

describe("oh-my-pi alignment: recommended option, wrapping tabs, notes", () => {
  test("the cursor starts on the recommended option (a bare Enter takes it)", () => {
    const question = select({ recommended: "b" });
    expect(createAskQuestionStates([question])[0]!.cursor).toBe(1);
    const { panel: p, settled } = panel([question]);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["b"] }] }]);
  });

  test("recommended is matched by VALUE, so option order does not matter", () => {
    const question = select({
      options: [
        { value: "x", label: "ex" },
        { value: "y", label: "why" },
        { value: "z", label: "zed" },
      ],
      recommended: "z",
    });
    expect(createAskQuestionStates([question])[0]!.cursor).toBe(2);
  });

  test("tabs WRAP in both directions (Tab off Submit returns to question 1)", () => {
    const { panel: p } = panel([select(), text()]);
    p.handleInput(TAB); // -> Q2
    p.handleInput(TAB); // -> Submit
    expect(p.render(80).join("\n")).toContain("Review answers");
    p.handleInput(TAB); // wraps -> Q1
    expect(p.render(80).join("\n")).not.toContain("Review answers");
    p.handleInput("\u001b[D"); // left from Q1 wraps -> Submit
    expect(p.render(80).join("\n")).toContain("Review answers");
  });

  test("`n` attaches a note to the focused row; it rides the answer", () => {
    const { panel: p, settled, type } = panel([select()]);
    p.handleInput("n");
    type("prefer this one, see ticket 42");
    p.handleInput(ENTER); // saves the note (does not submit)
    expect(settled).toHaveLength(0);
    // The note is visible on the row it was written on.
    expect(plain(p.render(80).join("\n"))).toContain("\u270e note");
    p.handleInput(ENTER); // now pick the option
    expect(settled).toEqual([
      {
        answers: [
          {
            id: "q1",
            selectedValues: ["a"],
            note: "prefer this one, see ticket 42",
          },
        ],
      },
    ]);
  });

  test("Esc inside a note keeps the previous note (an abandoned edit is not a deletion)", () => {
    const { panel: p, settled, type } = panel([select()]);
    p.handleInput("n");
    type("kept");
    p.handleInput(ENTER);
    p.handleInput("n");
    type(" discarded");
    p.handleInput(ESC);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["a"], note: "kept" }] }]);
  });

  test("an empty note submit clears it", () => {
    const { panel: p, settled, type } = panel([select()]);
    p.handleInput("n");
    type("temp");
    p.handleInput(ENTER);
    p.handleInput("n");
    // The buffer is seeded with the existing note; clearing it deletes the mark.
    for (let i = 0; i < "temp".length; i++) p.handleInput("\x7f");
    p.handleInput(ENTER);
    p.handleInput(ENTER);
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["a"] }] }]);
  });

  test("a note is dropped when its row stops being the answer", () => {
    const {
      panel: p,
      settled,
      type,
    } = panel([
      select({
        options: [
          { value: "a", label: "alpha" },
          { value: "b", label: "beta" },
        ],
      }),
    ]);
    p.handleInput("n");
    type("about alpha");
    p.handleInput(ENTER); // note on row 0
    p.handleInput(DOWN); // focus beta
    p.handleInput(ENTER); // pick beta -> alpha is no longer the answer
    expect(settled).toEqual([{ answers: [{ id: "q1", selectedValues: ["b"] }] }]);
  });

  test("the Submit review shows the note under its question", () => {
    const { panel: p, type } = panel([select(), text()]);
    p.handleInput("n");
    type("watch the cache");
    p.handleInput(ENTER);
    p.handleInput(ENTER); // pick the option -> Q2
    p.handleInput(ENTER); // text answer committed -> Submit
    const review = plain(p.render(80).join("\n"));
    expect(review).toContain("Review answers");
    expect(review).toContain("Note:");
    expect(review).toContain("watch the cache");
  });
});

describe("oh-my-pi alignment: option.preview", () => {
  test("a preview renders under its option row (markdown, so fences too)", () => {
    const question = select({
      options: [
        {
          value: "a",
          label: "alpha",
          preview: "**bold** and `code`\n\n```ts\nconst x = 1;\n```",
        },
      ],
    });
    const state = createAskQuestionStates([question])[0]!;
    const { lines } = renderAskRows(question, state, 60, undefined);
    const text = plain(lines.join("\n"));
    // The label, then the preview block indented under it.
    expect(text).toContain("alpha");
    expect(text).toContain("bold");
    expect(text).toContain("const x = 1;");
    expect(text.split("\n").length).toBeGreaterThan(3);
  });

  test("a preview long enough to overflow still maps rows to lines", () => {
    const question = select({
      options: [
        {
          value: "a",
          label: "alpha",
          preview: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n\n"),
        },
      ],
    });
    const state = createAskQuestionStates([question])[0]!;
    const { lines, lineStart } = renderAskRows(question, state, 60, undefined);
    // Row 0 owns every preview line, so row 1 (Other) starts after them all.
    expect(lineStart[1]).toBe(lines.length - 1);
  });
});

describe("oh-my-pi alignment: the inactivity timeout (ask.timeout)", () => {
  const multi = [
    select({ header: "A", recommended: "b" }),
    select({ id: "q2", header: "B", question: "Second?", options: [{ value: "x", label: "ex" }] }),
  ];

  test("expiry auto-answers UNANSWERED questions with their recommended option, marked timedOut", async () => {
    const { settled } = panel(multi, { timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toEqual([
      {
        answers: [
          { id: "q1", selectedValues: ["b"], timedOut: true },
          { id: "q2", selectedValues: ["x"], timedOut: true },
        ],
      },
    ]);
  });

  test("an already-answered question is left alone (no overwrite, no mark)", async () => {
    const { panel: p, settled } = panel(multi, { timeoutMs: 30 });
    p.handleInput(ENTER); // pick recommended on Q1 -> moves to Q2
    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toEqual([
      {
        answers: [
          { id: "q1", selectedValues: ["b"] },
          { id: "q2", selectedValues: ["x"], timedOut: true },
        ],
      },
    ]);
  });

  test("a keypress restarts the countdown (an engaged user never times out)", async () => {
    const { panel: p, settled } = panel([select()], { timeoutMs: 40 });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
      p.handleInput("x"); // any key counts as activity
    }
    expect(settled).toHaveLength(0);
  });

  test("the timer is deferred while a field is open, then runs on close", async () => {
    const { panel: p, settled, type } = panel([select()], { timeoutMs: 25 });
    p.handleInput(DOWN);
    p.handleInput(DOWN); // Other row
    p.handleInput(ENTER); // opens the field
    await new Promise((r) => setTimeout(r, 60));
    // The half-typed answer is never yanked: the timer waits for the field.
    expect(settled).toHaveLength(0);
    type("done");
    p.handleInput(ENTER);
    expect(settled).toHaveLength(1);
  });

  test("no timer at all when the timeout is 0 / absent (oh-my-pi's default)", async () => {
    const { panel: p, settled } = panel([select()]);
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toHaveLength(0);
    expect(p.render(80).join("\n")).not.toMatch(/Ask \(\d+s\)/);
  });

  test("the title counts down while the timer is live", () => {
    const { panel: p } = panel([select()], { timeoutMs: 30_000 });
    expect(plain(p.render(80)[0] ?? "")).toContain("Ask (30s)");
  });
});
