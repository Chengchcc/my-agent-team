import { describe, expect, test } from "bun:test";
import { Container, Markdown, Text, TUI, tuiTheme, VirtualTerminal } from "@chengchenccc/tui";
import { OmaTranscriptContainer } from "./tui-components.js";
import { MARKDOWN_THEME } from "./tui-format.js";
import { TuiItemRenderer, TuiRenderShell } from "./tui-render.js";
import { initialViewState, type TranscriptItem } from "./view-state.js";

const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "g"), "");

describe("TuiItemRenderer settle renders cold", () => {
  test("a streamed markdown item settles to the exact cold render of the final text", () => {
    const tui = new TUI(new VirtualTerminal(100, 30));
    const renderer = new TuiItemRenderer(tui);
    const state = initialViewState();
    const item: TranscriptItem = {
      kind: "assistant",
      text: "",
      streaming: true,
      thinking: "",
    };
    // Simulate the stream: progressively longer prefixes across frames,
    // including blank-line freeze boundaries, a list, and a table tail —
    // the shapes the streaming-prefix cache exercises.
    const full = [
      "## 报告",
      "",
      "**结论**: 一个分层清晰的 monorepo。",
      "",
      "- **workspaces**: `apps/*` + `packages/*`",
      "- **audit 体系**: 5 个门禁脚本",
      "",
      "| 层 | 内容 |",
      "|---|---|",
      "| 协议 | message |",
      "| 运行时 | oh-my-agent |",
      "",
      "报告完毕。",
    ].join("\n");
    for (let end = 1; end <= full.length; end += Math.ceil(full.length / 24)) {
      item.text = full.slice(0, end);
      renderer.renderItem(item, state);
    }
    // Settle with the complete text.
    item.text = full;
    item.streaming = false;
    const settled = renderer.renderItem(item, state);
    // The settle frame must equal a COLD render of the same text (what
    // /resume replays) — no streaming-prefix artifacts committed.
    const cold = new Markdown(full, 1, 0, MARKDOWN_THEME).render(100);
    expect(settled).toEqual(cold);
    // And idempotent afterwards (settled cache serves the same lines).
    expect(renderer.renderItem(item, state)).toEqual(settled);
    // Sanity: the cold render itself is well-formed (bold consumed).
    expect(stripAnsi(settled.join("\n"))).not.toContain("**");
  });
});

/** The border is the state's verdict channel (output-block STATE_BORDER):
 *  this locks the CALL SITE — renderTool must derive running/error/success
 *  from the item and hand it to the block, so the frame color answers
 *  "live / failed / done" at a glance. The mapping itself is pinned in
 *  packages/tui output-block.test.ts; if either end regresses, the border
 *  silently stops encoding status. */
describe("tool card border carries the state verdict", () => {
  const topBar = (item: TranscriptItem): string => {
    const tui = new TUI(new VirtualTerminal(100, 30));
    return new TuiItemRenderer(tui).renderItem(item, initialViewState())[0] ?? "";
  };

  test("streaming card → gold (warning) border, same token as the ⟳ title", () => {
    const top = topBar({ kind: "tool", text: "bash…", streaming: true, startedAt: Date.now() });
    expect(top).toContain(tuiTheme.warning);
    expect(top).toContain("bash");
  });

  test("failed card → crimson (error) border", () => {
    const top = topBar({
      kind: "tool",
      text: "bash",
      streaming: false,
      result: { content: "boom", isError: true },
    });
    expect(top).toContain(tuiTheme.error);
  });

  test("settled-ok card → jade (success) border", () => {
    const top = topBar({
      kind: "tool",
      text: "bash",
      streaming: false,
      result: { content: "[exit: 0]" },
    });
    expect(top).toContain(tuiTheme.success);
  });
});

/** The commit frontier must be fitted against PHYSICAL rows: a Text that
 *  wraps at the current width renders several rows, so the old
 *  childCount-minus-available arithmetic committed mid-block on narrow
 *  terminals and after resizes. */
describe("OmaTranscriptContainer.fitTailBoundary", () => {
  const build = (): OmaTranscriptContainer => {
    const c = new OmaTranscriptContainer();
    c.addChild(new Text("short", 0, 0)); // 1 row @10
    c.addChild(new Text("0123456789A", 0, 0)); // wraps to 2 rows @10
    c.addChild(new Text("tail", 0, 0)); // 1 row
    return c;
  };

  test("counts wrapped rows, not children", () => {
    // Heights [1,2,1]; budget 2 keeps only the last child live → commit [0,2)
    // = 3 physical rows. The old arithmetic (3 children − 2) said 1.
    expect(build().fitTailBoundary(10, 2)).toBe(2);
    expect(build().fitTailBoundary(10, 4)).toBe(0); // everything fits
  });

  test("a streaming child never commits (liveStart clamp)", () => {
    // Budget 2 walks the boundary to child 2; liveStart=1 must stop it AT
    // the streaming child (commit [0,1), keep 1..2 live).
    expect(build().fitTailBoundary(10, 2, 1)).toBe(1);
    // Everything streaming: commit nothing.
    expect(build().fitTailBoundary(10, 2, 0)).toBe(0);
    // Budget fits all: boundary 0 regardless of liveStart.
    expect(build().fitTailBoundary(10, 4, 2)).toBe(0);
  });

  test("a last child taller than the budget stays live (no blank viewport)", () => {
    const c = new OmaTranscriptContainer();
    c.addChild(new Text("x", 0, 0)); // 1 row
    c.addChild(new Text("0123456789ABCDEF", 0, 0)); // 2 rows @10
    expect(c.fitTailBoundary(10, 1)).toBe(1);
  });
});

describe("header survives a transcript reset (the /new case)", () => {
  const headerRows = (transcript: OmaTranscriptContainer): number =>
    transcript.children.filter((c) => c.render(100).some((l) => l.includes("workspace:"))).length;

  test("a wiped transcript keeps exactly one header card", () => {
    const tui = new TUI(new VirtualTerminal(100, 30));
    const transcript = new OmaTranscriptContainer();
    const shell = new TuiRenderShell(tui, transcript, new Container(), "/ws", "");
    const state = initialViewState();

    shell.setHeader("fake/model", "session-one", "First");
    expect(headerRows(transcript)).toBe(1);

    // /new: a fresh session id plus an emptied item list — the reconcile sees
    // a shrink, resets the container, and the header card is not a reconciled
    // group, so nothing would re-add it.
    shell.setHeader("fake/model", "session-two", "");
    shell.render(state);
    expect(headerRows(transcript)).toBe(1);

    // Re-rendering the same state must not stack a second copy.
    shell.render(state);
    shell.render(state);
    expect(headerRows(transcript)).toBe(1);
  });

  test("a reset before any header was printed stays quiet", () => {
    const tui = new TUI(new VirtualTerminal(100, 30));
    const transcript = new OmaTranscriptContainer();
    const shell = new TuiRenderShell(tui, transcript, new Container(), "/ws", "");
    shell.render(initialViewState());
    expect(headerRows(transcript)).toBe(0);
  });
});
