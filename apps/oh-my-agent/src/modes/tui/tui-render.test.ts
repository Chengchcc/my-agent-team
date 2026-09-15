import { describe, expect, test } from "bun:test";
import { Container, Markdown, TUI, VirtualTerminal } from "@chengchenccc/tui";
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
