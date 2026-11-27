import { describe, expect, test } from "bun:test";
import { plainTheme, resolveTheme, tuiTheme } from "../theme.js";
import { visibleWidth } from "../utils.js";
import { Markdown, type MarkdownTheme } from "./markdown.js";
import { renderModalFrame } from "./modal-frame.js";
import { SelectList, type SelectListTheme } from "./select-list.js";
import { chip, renderFlexStatusBar, renderMeter } from "./statusline.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const mdTheme: MarkdownTheme = {
  heading: (s) => s,
  link: (s) => s,
  linkUrl: (s) => s,
  code: (s) => s,
  codeBlock: (s) => s,
  codeBlockBorder: (s) => s,
  quote: (s) => s,
  quoteBorder: (s) => s,
  hr: (s) => s,
  listBullet: (s) => s,
  bold: (s) => s,
  italic: (s) => s,
  strikethrough: (s) => s,
  underline: (s) => s,
};

const listTheme: SelectListTheme = {
  selectedPrefix: (t) => `▸ ${t}`,
  selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
  selectedBg: (t) => `\x1b[48;5;236m${t}\x1b[0m`,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

describe("NO_COLOR theme resolution", () => {
  test("returns plainTheme when NO_COLOR is non-empty", () => {
    expect(resolveTheme({ NO_COLOR: "1" })).toBe(plainTheme);
    expect(resolveTheme({ NO_COLOR: "true" })).toBe(plainTheme);
    expect(plainTheme.accent).toBe("");
    expect(plainTheme.bgPanel).toBe("");
  });

  test("returns colored theme when NO_COLOR is unset or empty", () => {
    expect(resolveTheme({})).not.toBe(plainTheme);
    expect(resolveTheme({ NO_COLOR: "" })).not.toBe(plainTheme);
  });
});

describe("statusline primitives", () => {
  test("chip uses clean padded pill without jagged triangles", () => {
    const rendered = chip("oma", tuiTheme.bgPanel);
    const plain = stripAnsi(rendered);
    expect(plain).toBe(" oma ");
    expect(plain).not.toContain("◀");
    expect(plain).not.toContain("▶");
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
  });

  test("renderFlexStatusBar splits left and right segments and drops low priority at narrow widths", () => {
    const wide = stripAnsi(
      renderFlexStatusBar({
        width: 80,
        left: [
          { text: " plan ", priority: 1 },
          { text: "claude-sonnet-4", priority: 2 },
          { text: "my-agent-team", priority: 5 },
          { text: "main*", priority: 6 },
        ],
        right: [
          { text: "████░░░░ 50%", priority: 2 },
          { text: "100k/200k", priority: 7 },
        ],
      }),
    );
    expect(visibleWidth(wide)).toBe(80);
    expect(wide).toContain("plan");
    expect(wide).toContain("claude-sonnet-4");
    expect(wide).toContain("my-agent-team");
    expect(wide).toContain("50%");

    const narrow = stripAnsi(
      renderFlexStatusBar({
        width: 42,
        left: [
          { text: " plan ", priority: 1 },
          { text: "claude-sonnet-4", priority: 2 },
          { text: "my-agent-team", priority: 5 },
          { text: "main*", priority: 6 },
        ],
        right: [
          { text: "████░░░░ 50%", priority: 2 },
          { text: "100k/200k", priority: 7 },
        ],
      }),
    );
    expect(visibleWidth(narrow)).toBe(42);
    expect(narrow).toContain("plan");
    expect(narrow).toContain("claude-sonnet-4");
    expect(narrow).toContain("50%");
    expect(narrow).not.toContain("100k/200k");
  });

  test("renderMeter renders clamped gauge and percentage", () => {
    expect(stripAnsi(renderMeter(0, 8))).toBe("░░░░░░░░ 0%");
    expect(stripAnsi(renderMeter(50, 8))).toBe("████░░░░ 50%");
    expect(stripAnsi(renderMeter(120, 8))).toBe("████████ 100%");
    expect(renderMeter(75, 8)).toContain(tuiTheme.warning);
    expect(renderMeter(95, 8)).toContain(tuiTheme.error);
  });
});

describe("renderModalFrame", () => {
  test("draws complete rounded borders, divider, and footer fitted to exact width", () => {
    const lines = renderModalFrame({
      title: "Resume Session",
      titleRight: "3 sessions",
      lines: ["Filter: > foo", "---", "row 1", "row 2"],
      footer: "Enter open · Esc close",
      width: 44,
    });
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(44);
    }
    const plain = lines.map(stripAnsi);
    expect(plain[0]?.startsWith("╭─")).toBe(true);
    expect(plain[0]?.endsWith("╮")).toBe(true);
    expect(plain[0]).toContain("Resume Session");
    expect(plain[0]).toContain("3 sessions");
    expect(plain[2]?.startsWith("├")).toBe(true);
    expect(plain[2]?.endsWith("┤")).toBe(true);
    expect(plain[5]?.startsWith("╰─")).toBe(true);
    expect(plain[5]?.endsWith("╯")).toBe(true);
    expect(plain[5]).toContain("Enter open");
  });
});

describe("SelectList enhancements", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    value: `v${i}`,
    label: `item-${i}`,
    description: `description for item ${i} that is somewhat long`,
  }));

  test("renders selectedPrefix, selectedBg, ellipsis truncation, scrollbar, and custom emptyMessage", () => {
    const list = new SelectList(items, 5, listTheme, { emptyMessage: "  No sessions match" });
    const lines = list.render(50);
    expect(lines.length).toBe(6); // 5 visible + scroll info
    expect(stripAnsi(lines[0]!)).toContain("▸ item-0");
    expect(lines[0]).toContain("\x1b[48;5;236m");
    // Right-edge scrollbar thumb/track rendered on visible rows
    expect(lines.slice(0, 5).some((l) => stripAnsi(l).endsWith("┃"))).toBe(true);
    expect(lines.slice(0, 5).some((l) => stripAnsi(l).endsWith("│"))).toBe(true);

    list.setFilter("zzz-no-hit");
    const empty = list.render(50);
    expect(stripAnsi(empty[0]!)).toContain("No sessions match");
  });

  test("supports pageDown, pageUp, end, home and getSelectedIndex", () => {
    const list = new SelectList(items, 5, listTheme);
    expect(list.getSelectedIndex()).toBe(0);
    list.handleInput("\x1b[6~"); // PageDown (steps by maxVisible - 1 = 4)
    expect(list.getSelectedIndex()).toBe(4);
    list.handleInput("\x1b[F"); // End
    expect(list.getSelectedIndex()).toBe(11);
    list.handleInput("\x1b[5~"); // PageUp
    expect(list.getSelectedIndex()).toBe(7);
    list.handleInput("\x1b[H"); // Home
    expect(list.getSelectedIndex()).toBe(0);
  });
});

describe("Markdown streaming prefix render cache", () => {
  test("streaming incremental append produces identical output to one-shot render", () => {
    const chunks = [
      "# Heading\n\nFirst paragraph with **bold** and `code`.\n\n",
      "- bullet one\n- bullet two\n\n",
      "```ts\nconst x = 1;\nconst y = 2;\n```\n\n",
      "Final paragraph trailing text.",
    ];
    const streamed = new Markdown("", 1, 0, mdTheme);
    let acc = "";
    for (const chunk of chunks) {
      acc += chunk;
      streamed.setText(acc);
      streamed.render(60);
    }
    const streamedLines = streamed.render(60);

    const fresh = new Markdown(acc, 1, 0, mdTheme);
    const freshLines = fresh.render(60);
    expect(streamedLines).toEqual(freshLines);
  });
});
