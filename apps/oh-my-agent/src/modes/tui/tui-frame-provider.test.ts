import { describe, expect, test } from "bun:test";
import type { Component } from "@chengchenccc/tui";
import { Container, Text, TUI, VirtualTerminal } from "@chengchenccc/tui";
import { OmaTranscriptContainer } from "./tui-components.js";
import { createOmaFrameProvider } from "./tui-frame-provider.js";
import { TuiRenderShell } from "./tui-render.js";

/** The commit boundary must be fitted against PHYSICAL rows: a Text that
 *  wraps at the current width renders several rows, so the previous
 *  childCount-minus-available arithmetic committed mid-block on narrow
 *  terminals and after resizes. Asserted through the offered history row
 *  count — the black-box view of the frontier. */
describe("createOmaFrameProvider commit boundary", () => {
  const empty: Component = { render: () => [], invalidate: () => {} };
  test("wrapped children commit whole blocks (3 offered rows, not 1)", () => {
    const tui = new TUI(new VirtualTerminal(20, 5));
    const transcript = new OmaTranscriptContainer();
    transcript.addChild(new Text("short", 0, 0)); // 1 row @10
    transcript.addChild(new Text("0123456789A", 0, 0)); // wraps to 2 rows @10
    transcript.addChild(new Text("tail", 0, 0)); // 1 row
    const shell = new TuiRenderShell(tui, new OmaTranscriptContainer(), new Container(), "/ws", "");
    shell.lastLiveStartRow = 3;
    const provider = createOmaFrameProvider({
      transcript,
      statusContainer: new Container(),
      editor: empty,
      shell,
      bottom: () => empty,
    });

    const first = provider.renderFrame({ columns: 10, rows: 2 });
    // Old arithmetic: boundary = 3 children − 2 rows = 1 → 1 offered row,
    // and the 2-row block straddled scrollback and viewport.
    const offered = transcript.renderOfferedHistory(10);
    expect(offered?.rows.length).toBe(3);
    // Ack advances the frontier; the NEXT frame's live window is exactly
    // the last child (1 row), inside the budget.
    transcript.acknowledgeFinalizedBatch(offered!.id);
    const steady = provider.renderFrame({ columns: 10, rows: 2 });
    expect(steady.viewport.length).toBe(1);
    expect(steady.viewport[0]?.trimEnd()).toBe("tail");
    expect(first.viewport.length).toBeLessThanOrEqual(2);
  });

  test("a streaming child stays out of the scrollback (liveStart clamp)", () => {
    const tui = new TUI(new VirtualTerminal(20, 5));
    const transcript = new OmaTranscriptContainer();
    transcript.addChild(new Text("done", 0, 0));
    transcript.addChild(new Text("live…", 0, 0));
    const shell = new TuiRenderShell(tui, new OmaTranscriptContainer(), new Container(), "/ws", "");
    shell.lastLiveStartRow = 1; // child 1 is streaming
    const provider = createOmaFrameProvider({
      transcript,
      statusContainer: new Container(),
      editor: empty,
      shell,
      bottom: () => empty,
    });

    provider.renderFrame({ columns: 10, rows: 1 });
    // Boundary clamped to the streaming child: only "done" is offered.
    expect(transcript.renderOfferedHistory(10)?.rows.length).toBe(1);
  });
});
