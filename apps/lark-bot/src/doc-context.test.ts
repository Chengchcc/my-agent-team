import { describe, expect, test } from "bun:test";
import { composeCommentRunText, DOC_TEXT_LIMIT, fetchDocText } from "./doc-context.js";

const TOKEN = "OoT1dYksjoCEYWxolMim4v0dy4c";

describe("what a comment-triggered run reads", () => {
  test("the comment first, the document as context", () => {
    const text = composeCommentRunText({
      body: "总结一下",
      fileToken: TOKEN,
      docText: "# 标题\n\n正文",
    });
    expect(text.startsWith("总结一下")).toBe(true);
    expect(text).toContain(`<document token="${TOKEN}">`);
    expect(text).toContain("正文");
  });

  test("a long document is clipped, and says so", () => {
    const text = composeCommentRunText({
      body: "总结一下",
      fileToken: TOKEN,
      docText: "x".repeat(DOC_TEXT_LIMIT + 500),
    });
    expect(text).toContain("已截断");
    expect(text.length).toBeLessThan(DOC_TEXT_LIMIT + 200);
  });

  test("a document we could not read says THAT, so the model does not go hunting", () => {
    // The live failure: told nothing, the model's first idea was to inspect the
    // host's processes, which needs approval - and a comment lane cannot ask.
    const text = composeCommentRunText({ body: "总结一下", fileToken: TOKEN, docText: null });
    expect(text).toContain("正文未取到");
    expect(text).toContain("总结一下");
  });
});

describe("fetching a document's text", () => {
  test("the CLI's stdout is the text", async () => {
    const seen: string[][] = [];
    const text = await fetchDocText({
      profile: "agent:default",
      fileToken: TOKEN,
      run: (args) => {
        seen.push(args);
        return { code: 0, out: "# 标题\n\n正文\n" };
      },
    });
    expect(text).toBe("# 标题\n\n正文");
    expect(seen[0]).toContain("+fetch");
    expect(seen[0]).toContain(TOKEN);
    expect(seen[0]).toContain("markdown");
  });

  test("a non-zero exit is a null, not a throw", async () => {
    const text = await fetchDocText({
      profile: "p",
      fileToken: TOKEN,
      run: () => ({ code: 3, out: "no permission" }),
    });
    expect(text).toBeNull();
  });

  test("a spawn that throws is a null too", async () => {
    const text = await fetchDocText({
      profile: "p",
      fileToken: TOKEN,
      run: () => {
        throw new Error("lark-cli missing");
      },
    });
    expect(text).toBeNull();
  });

  test("empty output is a null (nothing to add)", async () => {
    const text = await fetchDocText({
      profile: "p",
      fileToken: TOKEN,
      run: () => ({ code: 0, out: "   \n" }),
    });
    expect(text).toBeNull();
  });
});
