import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findConversationByComment,
  getConversationBinding,
  openBindings,
} from "./bindings-sqlite.js";
import type { CommentTrigger } from "./channel-adapters.js";
import { commentChatId } from "./comment-scope.js";
import { ingestComment } from "./ingest-comment.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real migrations (openBindings), so the comment tables are the ones shipped. */
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "lark-comment-"));
  dirs.push(dir);
  return openBindings("test-agent", dir);
}

const FILE = "EWvsdouioonNMSxlY95m4uIly9w";

function trigger(over: Partial<CommentTrigger> = {}): CommentTrigger {
  return {
    fileToken: FILE,
    fileType: "docx",
    commentId: "7696351432357728318",
    replyId: "7696351432374521914",
    operatorOpenId: "ou_0a7dd0893c0d537a23f8dca52175b83b",
    mentionedBot: true,
    eventId: "c0bd64c73ade4e419dc28525cf8ccbfa",
    ...over,
  };
}

function deps(db: ReturnType<typeof makeDb>, creates: string[] = []) {
  const posts: Array<{ conversationId: string; senderMemberId: string; text: string }> = [];
  const bound: Array<{ conversationId: string; chatId: string }> = [];
  return {
    posts,
    bound,
    creates,
    deps: {
      db,
      createConversation: async () => {
        const id = `conv-${creates.length + 1}`;
        creates.push(id);
        return id;
      },
      postMessage: async (input: {
        conversationId: string;
        senderMemberId: string;
        text: string;
      }) => {
        posts.push(input);
        return {};
      },
      onNewBinding: (conversationId: string, chatId: string) => {
        bound.push({ conversationId, chatId });
      },
    },
  };
}

describe("ingestComment", () => {
  test("a first notice binds one comment line to one conversation", async () => {
    const db = makeDb();
    const creates: string[] = [];
    const h = deps(db, creates);

    const result = await ingestComment(trigger(), "这段写得不对", h.deps);

    expect(result.action).toBe("triggered");
    expect(result.conversationId).toBe("conv-1");
    expect(creates).toEqual(["conv-1"]);
    expect(h.posts).toEqual([
      {
        conversationId: "conv-1",
        senderMemberId: "human:lark:ou_0a7dd0893c0d537a23f8dca52175b83b",
        text: "这段写得不对",
      },
    ]);
    // The synthetic chat id is what makes the delivery machinery work unchanged.
    const chatId = commentChatId(FILE, "7696351432357728318");
    expect(getConversationBinding(db, "conv-1")?.larkChatId).toBe(chatId);
    expect(findConversationByComment(db, FILE, "7696351432357728318")).toBe("conv-1");
    // ...and the binding is what starts the AHP watcher that delivers answers.
    expect(h.bound).toEqual([{ conversationId: "conv-1", chatId }]);
    db.close();
  });

  test("a later reply in the same thread continues that conversation", async () => {
    const db = makeDb();
    const creates: string[] = [];
    const h = deps(db, creates);

    await ingestComment(trigger(), "第一句", h.deps);
    // A reply is its OWN notice: different event and reply id, same comment.
    const second = await ingestComment(
      trigger({ eventId: "evt-reply-2", replyId: "7696351432374521999" }),
      "那我改成这样",
      h.deps,
    );

    expect(second.action).toBe("triggered");
    expect(second.conversationId).toBe("conv-1");
    // Keying dedup on the comment instead of the notice would swallow this.
    expect(creates).toHaveLength(1);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.text).toBe("那我改成这样");
    db.close();
  });

  test("the same notice delivered twice triggers once", async () => {
    const db = makeDb();
    const h = deps(db);

    await ingestComment(trigger(), "只跑一次", h.deps);
    const again = await ingestComment(trigger(), "只跑一次", h.deps);

    expect(again.action).toBe("skipped");
    expect(h.posts).toHaveLength(1);
    db.close();
  });

  test("a backend that refuses to create leaves no binding behind", async () => {
    const db = makeDb();
    const posts: unknown[] = [];
    const bound: unknown[] = [];

    const result = await ingestComment(trigger(), "hi", {
      db,
      createConversation: async () => null,
      postMessage: async (input) => {
        posts.push(input);
        return {};
      },
      onNewBinding: (conversationId, chatId) => {
        bound.push({ conversationId, chatId });
      },
    });

    expect(result.action).toBe("error");
    expect(posts).toHaveLength(0);
    expect(bound).toHaveLength(0);
    expect(findConversationByComment(db, FILE, "7696351432357728318")).toBeNull();
    db.close();
  });
});
