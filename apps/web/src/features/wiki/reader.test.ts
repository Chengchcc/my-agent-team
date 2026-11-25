import { describe, expect, test } from "bun:test";
import {
  describeSource,
  extractToc,
  leadText,
  linkFootnotes,
  splitLead,
  stripInline,
} from "./reader";

describe("extractToc", () => {
  test("lists headings with readable, unique ids and their line", () => {
    const body = [
      "# Retry strategy",
      "",
      "Retries back off exponentially.",
      "",
      "## When to retry",
      "text",
      "### 503 errors",
      "text",
      "## When to retry",
    ].join("\n");
    const toc = extractToc(body);
    expect(toc.map((heading) => heading.id)).toEqual([
      "retry-strategy",
      "when-to-retry",
      "503-errors",
      "when-to-retry-2",
    ]);
    expect(toc.map((heading) => heading.level)).toEqual([1, 2, 3, 2]);
    expect(toc[1]?.line).toBe(5);
  });

  test("a heading inside a code fence is code, not a heading", () => {
    const body = "## Real\n\n```md\n## Not a heading\n```\n\n### Also real";
    expect(extractToc(body).map((heading) => heading.text)).toEqual(["Real", "Also real"]);
  });

  test("inline syntax is stripped and a heading of only symbols still gets an id", () => {
    const body =
      "## See [[Retry|the retry page]] and [docs](http://x)\n\n## ***\n\n## \u4e2d\u6587\u6807\u9898";
    const toc = extractToc(body);
    expect(toc.map((heading) => heading.text)).toEqual([
      "See the retry page and docs",
      "",
      "\u4e2d\u6587\u6807\u9898",
    ]);
    expect(toc.map((heading) => heading.id)).toEqual([
      "see-the-retry-page-and-docs",
      "section",
      "\u4e2d\u6587\u6807\u9898",
    ]);
  });

  test("a body without headings has an empty table", () => {
    expect(extractToc("Just text.\n\nMore text.")).toEqual([]);
  });
});

describe("splitLead", () => {
  test("the opening paragraph is the lead and the rest follows whole", () => {
    const body = "Retries back off [1].\nThey never retry forever.\n\n## When to retry\n\ntext";
    const parts = splitLead(body);
    expect(parts.lead).toBe("Retries back off [1].\nThey never retry forever.");
    expect(parts.rest).toBe("\n## When to retry\n\ntext");
  });

  test("a body that opens with a heading, a list or a fence has no lead", () => {
    expect(splitLead("## Title\n\ntext").lead).toBe("");
    expect(splitLead("- first\n- second\n\nafter").lead).toBe("");
    expect(splitLead("```\ncode\n```\n\nafter").lead).toBe("");
    expect(splitLead("").lead).toBe("");
  });

  test("a list right after the lead ends it", () => {
    const parts = splitLead("Lead line.\n- item one\n- item two");
    expect(parts.lead).toBe("Lead line.");
    expect(parts.rest).toBe("- item one\n- item two");
  });
});

describe("leadText", () => {
  test("is one plain line", () => {
    expect(leadText("**Bold** start\nwrapped `line`.")).toBe("Bold start wrapped line.");
  });
  test("is cut at 200 characters", () => {
    const lead = leadText("x".repeat(240));
    expect(lead.length).toBe(200);
    expect([lead.endsWith("…")]).toEqual([true]);
  });
});

describe("linkFootnotes", () => {
  test("a marker within the sources becomes a link to that source", () => {
    expect(linkFootnotes("see [2] here", 2)).toBe("see [[2]](#wiki-source-2) here");
  });
  test("a marker past the sources, a wikilink and a link stay as written", () => {
    expect(linkFootnotes("see [3] here", 2)).toBe("see [3] here");
    expect(linkFootnotes("[[1]]", 2)).toBe("[[1]]");
    expect(linkFootnotes("[1](http://x)", 2)).toBe("[1](http://x)");
  });
});

describe("stripInline", () => {
  test("images keep their alt text and emphasis disappears", () => {
    expect(stripInline("![diagram](a.png) and _thin_ ~~gone~~")).toBe("diagram and thin gone");
  });
});

describe("describeSource", () => {
  test("a conversation range links to its first message", () => {
    const ref = describeSource("conversation:c_01:12-40");
    expect([ref.kind, ref.label, ref.reference, ref.href]).toEqual([
      "conversation",
      "Conversation",
      "c_01 · messages 12–40",
      "/chat/c_01?at=12",
    ]);
  });
  test("a file is named, not linked; an address is linked; the rest is text", () => {
    expect(describeSource("file:raw/files/notes.md")).toEqual({
      kind: "file",
      label: "File",
      reference: "raw/files/notes.md",
      href: null,
    });
    expect(describeSource("https://example.test/a").href).toBe("https://example.test/a");
    expect(describeSource("someones note")).toEqual({
      kind: "text",
      label: "Source",
      reference: "someones note",
      href: null,
    });
  });
});
