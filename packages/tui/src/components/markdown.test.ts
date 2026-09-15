import { afterEach, describe, expect, test } from "bun:test";
import { resolveMermaidAscii } from "../mermaid.ts";
import { setTextSizingEnabled } from "../text-sizing.ts";
import { visibleWidth } from "../utils.ts";
import { Markdown, type MarkdownTheme } from "./markdown.ts";

const theme: MarkdownTheme = {
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

const wideDiagram = `graph LR
  Start[Start Request] --> Auth{Auth Valid?}
  Auth --No--> Deny[401 Unauthorized]
  Auth --Yes--> Query[Query Service] --> DB[(Database)]
  Query --> Build[Build Response] --> OK[200 OK]`;

describe("markdown mermaid", () => {
  test("clips wide mermaid ASCII rows instead of wrapping them", () => {
    const md = new Markdown(`\`\`\`mermaid\n${wideDiagram}\n\`\`\``, 0, 0, theme);
    const resolved = resolveMermaidAscii(wideDiagram, { maxWidth: 40 });
    expect(resolved).not.toBeNull();
    const resolvedLines = resolved!.split("\n");
    // Re-fit can pick a taller TD layout when the base LR graph overflows.

    const rendered = md.render(40);
    // Every preformatted row stays exactly one row; the wrap pass must not
    // fragment the box-drawing canvas.
    expect(rendered.length).toBe(resolvedLines.length);
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("open mermaid fence stays a code fence until the closing fence arrives", () => {
    const md = new Markdown(`\`\`\`mermaid\n${wideDiagram}`, 0, 0, theme);
    const rendered = md.render(80).join("\n");
    // No ASCII diagram while the fence is still streaming (would re-layout every
    // chunk and stall the TUI); render the raw fence instead.
    expect(rendered).toContain("```mermaid");
    expect(rendered).not.toContain("┌");
  });
});

describe("markdown streaming lex cache", () => {
  test("append across blank-line boundaries matches one-shot render", () => {
    const full = "# Title\n\nThis is a paragraph.\n\n- item one\n- item two";
    const expected = new Markdown(full, 0, 0, theme).render(80);
    const stream = new Markdown("", 0, 0, theme);
    let acc = "";
    for (const chunk of ["# Title", "\n\nThis is a paragraph.", "\n\n- item one\n- item two"]) {
      acc += chunk;
      stream.setText(acc);
      const rendered = stream.render(80);
      // Every intermediate render must already match the one-shot tail prefix.
      if (acc === full) {
        expect(rendered).toEqual(expected);
      }
    }
    expect(stream.render(80)).toEqual(expected);
  });

  test("single long paragraph without a blank line falls back safely", () => {
    const long = "This is a long sentence. ".repeat(60).trim();
    const expected = new Markdown(long, 0, 0, theme).render(80);
    const stream = new Markdown("", 0, 0, theme);
    let acc = "";
    for (let i = 0; i < long.length; i += 47) {
      acc += long.slice(i, i + 47);
      stream.setText(acc);
    }
    expect(stream.render(80)).toEqual(expected);
  });
});

describe("heading hierarchy (omp parity)", () => {
  afterEach(() => setTextSizingEnabled(undefined));

  test("a level-3+ marker goes through headingMarker when the theme has one", () => {
    const marked: MarkdownTheme = { ...theme, headingMarker: (t) => `<${t}>` };
    const rows = new Markdown("### Layer one\n\nbody", 0, 0, marked).render(40);
    expect(rows[0]).toContain("<### >");
    // Level 1 and 2 carry no marker at all.
    const h2 = new Markdown("## Section\n\nbody", 0, 0, marked).render(40);
    expect(h2[0]).not.toContain("<");
  });

  test("h1 is sized only when the capability is on and the doubled width fits", () => {
    setTextSizingEnabled(false);
    const plain = new Markdown("# Report\n\nbody", 0, 0, theme).render(40);
    expect(plain.join("\n")).not.toContain("]66;");

    setTextSizingEnabled(true);
    const sized = new Markdown("# Report\n\nbody", 0, 0, theme).render(40);
    expect(sized.join("\n")).toContain("]66;s=2;");
    // The doubled glyph occupies two rows: the renderer reserves the second
    // (padded to the container width like every other row).
    expect(sized[1]?.trim()).toBe("");
    // Body text is untouched.
    expect(sized.join("\n")).toContain("body");

    // A heading too wide to double stays at normal size instead of wrapping.
    const wide = `# ${"x".repeat(30)}`;
    const narrow = new Markdown(`${wide}\n\nbody`, 0, 0, theme).render(40);
    expect(narrow.join("\n")).not.toContain("]66;");
  });
});
