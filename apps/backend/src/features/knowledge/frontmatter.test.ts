import { describe, expect, test } from "bun:test";
import { parseKnowledgeFrontmatter } from "./frontmatter.js";

describe("knowledge frontmatter", () => {
  test("reads the four fields and strips the block from the body", () => {
    const meta = parseKnowledgeFrontmatter(
      "---\ntitle: Run lifecycle\ndescription: How a run ends\ntags: [runs, backend]\n---\n\n# Body\n",
    );
    expect(meta.title).toBe("Run lifecycle");
    expect(meta.description).toBe("How a run ends");
    expect(meta.tags).toEqual(["runs", "backend"]);
    expect(meta.hide).toBe(false);
    expect(meta.body).toBe("\n# Body\n");
  });
  test("a file without frontmatter keeps its whole text as the body", () => {
    const meta = parseKnowledgeFrontmatter("# Just a doc\n\ntext\n");
    expect(meta.title).toBe("");
    expect(meta.description).toBe("");
    expect(meta.tags).toEqual([]);
    expect(meta.body).toBe("# Just a doc\n\ntext\n");
  });
  test("an unterminated block is body, not frontmatter", () => {
    const text = "---\ntitle: broken\n\n# Body\n";
    expect(parseKnowledgeFrontmatter(text).body).toBe(text);
  });
  test("hide is honoured and an unknown key is ignored", () => {
    const meta = parseKnowledgeFrontmatter(
      "---\nsummary: not a field any more\ntags: runs\nhide: true\n---\nbody\n",
    );
    expect(meta.description).toBe("");
    expect(meta.tags).toEqual(["runs"]);
    expect(meta.hide).toBe(true);
  });
  test("CRLF, a BOM, quotes and a trailing comment do not break parsing", () => {
    const meta = parseKnowledgeFrontmatter(
      '\uFEFF---\r\ntitle: "Quoted"   # comment\r\ndescription: x\r\n---\r\nbody\r\n',
    );
    expect(meta.title).toBe("Quoted");
    expect(meta.description).toBe("x");
    expect(meta.body).toBe("body\r\n");
  });
  test("unknown keys and comment lines are ignored", () => {
    const meta = parseKnowledgeFrontmatter(
      "---\n# a note\nowner: someone\nnote: not a known key\n---\nbody\n",
    );
    expect(meta.title).toBe("");
    expect(meta.description).toBe("");
    expect(meta.body).toBe("body\n");
  });
});
