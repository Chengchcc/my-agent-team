import { describe, expect, test } from "bun:test";
import { Markdown, TUI, VirtualTerminal } from "@chengchenccc/tui";
import { MARKDOWN_THEME } from "./tui-format.js";
import { TuiItemRenderer } from "./tui-render.js";
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
