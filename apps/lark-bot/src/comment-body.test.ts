import { describe, expect, test } from "bun:test";
import type { FetchedComment } from "@larksuite/channel";
import { commentBodyOf } from "./comment-body.js";

const fetched = (over: Partial<FetchedComment> = {}): FetchedComment => ({
  commentId: "7696351432357728318",
  replies: [
    {
      reply_id: "r1",
      content: { elements: [{ type: "text_run", text_run: { text: "第一句" } }] },
    },
    {
      reply_id: "r2",
      content: { elements: [{ type: "text_run", text_run: { text: "那我改成这样" } }] },
    },
  ],
  isWhole: true,
  ...over,
});

describe("the text a comment run reads", () => {
  test("picks the named reply out of the thread", () => {
    // Answering the newest reply is only correct when the notice names it.
    expect(commentBodyOf(fetched(), "r1")).toBe("第一句");
    expect(commentBodyOf(fetched(), "r2")).toBe("那我改成这样");
  });

  test("falls back to the newest reply when the notice names none", () => {
    expect(commentBodyOf(fetched())).toBe("那我改成这样");
  });

  test("keeps links and drops mention markers", () => {
    const body = commentBodyOf(
      fetched({
        replies: [
          {
            reply_id: "r1",
            content: {
              elements: [
                { type: "text_run", text_run: { text: "看 " } },
                { type: "docs_link", docs_link: { url: "https://example.com/a" } },
                { type: "text_run", text_run: { text: " 和 " } },
                { type: "person", person: { user_id: "ou_x" } },
              ],
            },
          },
        ],
      }),
      "r1",
    );
    // A mention is the trigger itself and carries only a user id: a placeholder
    // in its place read as "someone was mentioned" and derailed the run.
    expect(body).toBe("看 https://example.com/a 和");
  });

  test("an inline comment carries what it is about", () => {
    const body = commentBodyOf(
      fetched({ quote: "这段写得不对", replies: fetched().replies.slice(0, 1) }),
      "r1",
    );
    expect(body).toBe("针对选中内容「这段写得不对」的评论：第一句");
  });

  test("an empty thread yields empty text, never a crash", () => {
    expect(commentBodyOf(fetched({ replies: [] }), "r1")).toBe("");
  });
});
