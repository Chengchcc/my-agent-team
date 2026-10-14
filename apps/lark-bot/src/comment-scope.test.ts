import { describe, expect, test } from "bun:test";
import { commentChatId, isCommentChatId, parseCommentChatId } from "./comment-scope.js";

describe("a comment line's synthetic chat id", () => {
  test("round-trips the document and the thread", () => {
    const id = commentChatId("EWvsdouioonNMSxlY95m4uIly9w", "7696351432357728318");
    expect(id).toBe("comment:EWvsdouioonNMSxlY95m4uIly9w:7696351432357728318");
    expect(isCommentChatId(id)).toBe(true);
    expect(parseCommentChatId(id)).toEqual({
      fileToken: "EWvsdouioonNMSxlY95m4uIly9w",
      commentId: "7696351432357728318",
    });
  });

  test("an ordinary chat id is not a comment scope", () => {
    expect(isCommentChatId("oc_0fcfb9f5401af46945f9ecb20d6e0669")).toBe(false);
    expect(parseCommentChatId("oc_0fcfb9f5401af46945f9ecb20d6e0669")).toBeNull();
  });

  test("a malformed comment scope is not answered anywhere", () => {
    // No separator, empty halves: each would otherwise send the reply to a
    // document or a thread that does not exist.
    expect(parseCommentChatId("comment:")).toBeNull();
    expect(parseCommentChatId("comment:onlytoken")).toBeNull();
    expect(parseCommentChatId("comment::7696")).toBeNull();
    expect(parseCommentChatId("comment:token:")).toBeNull();
  });
});
