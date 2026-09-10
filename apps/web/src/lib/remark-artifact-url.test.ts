import { describe, expect, test } from "bun:test";
import { remarkArtifactUrls } from "./remark-artifact-url";

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function text(value: string): Node {
  return { type: "text", value };
}

function para(value: string): Node {
  return { type: "paragraph", children: [text(value)] };
}

function transform(tree: Node): Node {
  remarkArtifactUrls()(tree);
  return tree;
}

describe("remarkArtifactUrls", () => {
  test("converts a bare artifact URL into a link node", () => {
    const out = transform(para("artifacts://runs/r1/report.txt")).children![0]!;
    expect(out).toEqual({
      type: "link",
      url: "artifacts://runs/r1/report.txt",
      children: [{ type: "text", value: "artifacts://runs/r1/report.txt" }],
    });
  });

  test("splits prose around the URL", () => {
    const kids = transform(para("see artifacts://bin/blob.bin for details")).children!;
    expect(kids).toEqual([
      { type: "text", value: "see " },
      {
        type: "link",
        url: "artifacts://bin/blob.bin",
        children: [text("artifacts://bin/blob.bin")],
      },
      { type: "text", value: " for details" },
    ]);
  });

  test("handles multiple URLs in one text node", () => {
    const kids = transform(para("artifacts://a/one.txt and artifacts://b/two.txt")).children!;
    const links = kids.filter((c) => c.type === "link");
    expect(links.map((l) => l.url)).toEqual(["artifacts://a/one.txt", "artifacts://b/two.txt"]);
  });

  test("whitespace and parentheses terminate the URL", () => {
    const kids = transform(para("(grab artifacts://x/y.bin)")).children!;
    const link = kids.find((c) => c.type === "link");
    expect(link!.url).toBe("artifacts://x/y.bin");
  });

  test("code spans and code blocks are left untouched", () => {
    const codeSpan: Node = { type: "inlineCode", value: "artifacts://a/b.txt" };
    const codeBlock: Node = { type: "code", value: "artifacts://a/b.txt" };
    const tree: Node = { type: "paragraph", children: [codeSpan, codeBlock] };
    expect(transform(tree).children).toEqual([codeSpan, codeBlock]);
  });

  test("plain text passes through unchanged", () => {
    expect(transform(para("no artifacts here")).children).toEqual([text("no artifacts here")]);
  });

  test("walks nested structures (blockquote > paragraph > text)", () => {
    const tree: Node = {
      type: "blockquote",
      children: [para("artifacts://nested/deep.md")],
    };
    transform(tree);
    const inner = tree.children![0]!.children![0]!;
    expect(inner.type).toBe("link");
    expect(inner.url).toBe("artifacts://nested/deep.md");
  });

  test("nodes without children are a no-op", () => {
    expect(() => transform({ type: "break" })).not.toThrow();
    expect(transform({ type: "thematicBreak" }).children).toBeUndefined();
  });
});
