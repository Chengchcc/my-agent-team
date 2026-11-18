import { describe, expect, test } from "bun:test";
import { endsWithQuestion, lastParagraph } from "./unasked-question.js";

describe("the closing-question observation", () => {
  test("a closing question is the shape we care about", () => {
    expect(endsWithQuestion("修好了。\n\n要我顺便把日志也清掉吗？")).toBe(true);
    expect(endsWithQuestion("Done.\n\nWhich branch should I merge into?")).toBe(true);
  });

  test("prose without a closing question is not flagged", () => {
    expect(endsWithQuestion("修好了，测试通过。")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
    expect(endsWithQuestion("   \n\n  ")).toBe(false);
  });

  test("a question mark inside a code block is not a question to the human", () => {
    // A `?` in a snippet is exactly the false positive that would make this
    // fact useless.
    expect(endsWithQuestion("改完了：\n\n```ts\ntype X = Y extends Z ? A : B;\n```")).toBe(false);
  });

  test("only the last paragraph counts", () => {
    // A question in the middle is usually quoted from the human or the task.
    expect(endsWithQuestion("你问为什么不生效？因为顺序。\n\n结论：已修。")).toBe(false);
    expect(lastParagraph("a\n\nb\n\nc")).toBe("c");
  });
});
