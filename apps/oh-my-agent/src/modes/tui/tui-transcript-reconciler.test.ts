import { describe, expect, test } from "bun:test";
import { OmaTranscriptContainer } from "./tui-components.js";
import { TuiTranscriptReconciler } from "./tui-transcript-reconciler.js";
import { initialViewState, type RunViewState, type TranscriptItem } from "./view-state.js";

/** renderItem double: an assistant item with no text renders TRANSPARENT
 * (zero rows) like the real renderer's empty placeholder; everything else
 * renders one row. */
const renderItem = (item: TranscriptItem): string[] =>
  item.kind === "assistant" && item.text === "" ? [] : [`${item.kind}:${item.text}`];

function runOf(items: TranscriptItem[]): RunViewState {
  return { items, running: true };
}

function reconcileRuns(
  reconciler: TuiTranscriptReconciler,
  transcript: OmaTranscriptContainer,
  runs: RunViewState[],
): boolean {
  return reconciler.reconcile(transcript, runs, initialViewState(), renderItem).didReset;
}

describe("TuiTranscriptReconciler didReset heuristic", () => {
  test("an item born transparent does not detonate the next reconcile", () => {
    const reconciler = new TuiTranscriptReconciler();
    const transcript = new OmaTranscriptContainer();
    const prompt: TranscriptItem = { kind: "user", text: "go", streaming: false };
    const emptyAssistant: TranscriptItem = { kind: "assistant", text: "", streaming: true };

    // First reconcile: the assistant placeholder renders zero rows.
    expect(
      reconcileRuns(reconciler, transcript, [
        { items: [prompt], running: false },
        runOf([emptyAssistant]),
      ]),
    ).toBe(false);

    // The live run gains a tool item AND a steer echo run appends — a pure
    // suffix extension of the item list. Pre-fix this tripped the positional
    // key check (the placeholder never entered orderKeys) and forced a full
    // clear + scrollback purge.
    const tool: TranscriptItem = { kind: "tool", text: "bash", streaming: false };
    const echo: TranscriptItem = { kind: "user", text: "mid", streaming: false, pending: true };
    expect(
      reconcileRuns(reconciler, transcript, [
        { items: [prompt], running: false },
        runOf([emptyAssistant, tool]),
        { items: [echo], running: false },
      ]),
    ).toBe(false);

    // The placeholder streams text (transparent -> visible): still no reset.
    const assistant: TranscriptItem = { kind: "assistant", text: "hello", streaming: true };
    expect(
      reconcileRuns(reconciler, transcript, [
        { items: [prompt], running: false },
        runOf([assistant, tool]),
        { items: [echo], running: false },
      ]),
    ).toBe(false);
  });

  test("item removal resets (compaction must rebuild)", () => {
    const reconciler = new TuiTranscriptReconciler();
    const transcript = new OmaTranscriptContainer();
    const prompt: TranscriptItem = { kind: "user", text: "go", streaming: false };
    const status: TranscriptItem = { kind: "status", text: "note", streaming: false };
    expect(
      reconcileRuns(reconciler, transcript, [{ items: [prompt], running: false }, runOf([status])]),
    ).toBe(false);
    expect(reconcileRuns(reconciler, transcript, [{ items: [prompt], running: false }])).toBe(true);
  });

  test("mid-list insertion self-heals without a reset (keys recycle in place)", () => {
    const reconciler = new TuiTranscriptReconciler();
    const transcript = new OmaTranscriptContainer();
    const prompt: TranscriptItem = { kind: "user", text: "go", streaming: false };
    const tool: TranscriptItem = { kind: "tool", text: "bash", streaming: false };
    expect(
      reconcileRuns(reconciler, transcript, [{ items: [prompt], running: false }, runOf([tool])]),
    ).toBe(false);
    // Insertion before the last item: the intruder takes the recycled
    // "1:0" slot (updateGroup swaps its rows in place) and the shifted tool
    // appends as a fresh "1:1" group — final order is correct with NO
    // destructive rebuild. Positional keys cannot even SEE pure insertions;
    // only removal/reorder (prefix mismatch) resets.
    const intruder: TranscriptItem = {
      kind: "status",
      text: "pushed before tool",
      streaming: false,
    };
    expect(
      reconcileRuns(reconciler, transcript, [
        { items: [prompt], running: false },
        runOf([intruder, tool]),
      ]),
    ).toBe(false);
    const rows = transcript.children
      .flatMap((child) => child.render(80))
      .map((line) => line.trimEnd());
  });
});
