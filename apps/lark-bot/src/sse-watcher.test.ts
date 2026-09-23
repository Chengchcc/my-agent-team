import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import type { MessageRevision } from "@chengchenccc/message";
import {
  getChatBinding,
  getMessageDelivery,
  openBindings,
  putChatBinding,
} from "./bindings-sqlite.js";
import { renderRevision } from "./render.js";
import { processEntry } from "./sse-watcher.js";

function makeRevision(overrides: Partial<MessageRevision> = {}): MessageRevision {
  return {
    messageId: "msg:test:1",
    role: "assistant",
    state: "done",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("renderRevision (used by SSE watcher)", () => {
  test("renders agent text reply from blocks", () => {
    const rev = makeRevision({
      blocks: [{ type: "text", text: "Hello from agent" }],
    });
    expect(renderRevision(rev)).toBe("Hello from agent");
  });

  test("renders simple text", () => {
    expect(renderRevision(makeRevision({ text: "simple" }))).toBe("simple");
  });

  test("renders empty as fallback", () => {
    expect(renderRevision(makeRevision())).toBe("[Unsupported content]");
  });
});

describe("processEntry delivery semantics", () => {
  const testDir = `/tmp/test-lark-sse-watcher-${Date.now()}`;
  let db: Database;

  function makeEvent(seq: number, revision: MessageRevision) {
    return { seq, kind: "message" as const, message: revision };
  }

  function handlers(onSend: (chatId: string, text: string, key: string) => Promise<void>) {
    return { onSend };
  }

  afterAll(() => {
    db?.close();
  });

  test("openBindings + fixture binding", () => {
    db = openBindings("test-agent", testDir);
    putChatBinding(db, "oc_test", "conv_test", "p2p", Date.now());
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(0);
  });

  test("successful send confirms terminal delivery and advances pushed_seq", async () => {
    const sent: Array<{ chatId: string; text: string; key: string }> = [];
    const event = makeEvent(7, makeRevision({ messageId: "msg:ok:1", text: "final answer" }));
    await processEntry(
      event,
      "conv_test",
      "oc_test",
      db,
      0,
      handlers(async (chatId, text, key) => {
        sent.push({ chatId, text, key });
      }),
    );
    expect(sent).toEqual([
      { chatId: "oc_test", text: "final answer", key: "conv_test:msg:ok:1:7" },
    ]);
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(7);
    const delivery = getMessageDelivery(db, "conv_test", "msg:ok:1", "oc_test");
    expect(delivery?.lastState).toBe("done");
  });

  test("replay of a confirmed delivery is skipped without re-sending", async () => {
    let sendCalls = 0;
    const event = makeEvent(7, makeRevision({ messageId: "msg:ok:1", text: "final answer" }));
    await processEntry(
      event,
      "conv_test",
      "oc_test",
      db,
      6,
      handlers(async () => {
        sendCalls++;
      }),
    );
    expect(sendCalls).toBe(0);
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(7);
  });

  test("P0: exhausted retries throw, do NOT advance pushed_seq, leave non-terminal marker", async () => {
    const cursorBefore = getChatBinding(db, "oc_test")?.pushedSeq ?? 0;
    const event = makeEvent(9, makeRevision({ messageId: "msg:lost:1", text: "gone" }));
    await expect(
      processEntry(
        event,
        "conv_test",
        "oc_test",
        db,
        cursorBefore,
        handlers(async () => {
          throw new Error("lark down");
        }),
      ),
    ).rejects.toThrow("lark down");
    // Cursor unchanged: the reconnect must replay this seq.
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(cursorBefore);
    // Non-terminal marker: the replay path re-sends with the same idempotency
    // key instead of hitting the terminal-skip guard.
    const delivery = getMessageDelivery(db, "conv_test", "msg:lost:1", "oc_test");
    expect(delivery?.lastState).toBe("streaming");
  });

  test("retry succeeds on the second attempt without duplicate sends", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const event = makeEvent(11, makeRevision({ messageId: "msg:retry:1", text: "later" }));
    await processEntry(
      event,
      "conv_test",
      "oc_test",
      db,
      10,
      handlers(async (_c, _t, key) => {
        attempts++;
        keys.push(key);
        if (attempts === 1) throw new Error("transient");
      }),
    );
    expect(attempts).toBe(2);
    expect(keys).toEqual(["conv_test:msg:retry:1:11", "conv_test:msg:retry:1:11"]);
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(11);
    expect(getMessageDelivery(db, "conv_test", "msg:retry:1", "oc_test")?.lastState).toBe("done");
  });

  test("tool rows are never delivered: seq advances, no send, no delivery record", async () => {
    let sendCalls = 0;
    const event = makeEvent(
      13,
      makeRevision({ messageId: "msg:tool:1", role: "tool", text: "stdout: ..." }),
    );
    await processEntry(
      event,
      "conv_test",
      "oc_test",
      db,
      12,
      handlers(async () => {
        sendCalls++;
      }),
    );
    expect(sendCalls).toBe(0);
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(13);
    expect(getMessageDelivery(db, "conv_test", "msg:tool:1", "oc_test")).toBeNull();
  });

  test("user echo advances seq without sending", async () => {
    let sendCalls = 0;
    const event = makeEvent(
      14,
      makeRevision({ messageId: "msg:user:1", role: "user", text: "my own words" }),
    );
    await processEntry(
      event,
      "conv_test",
      "oc_test",
      db,
      13,
      handlers(async () => {
        sendCalls++;
      }),
    );
    expect(sendCalls).toBe(0);
    expect(getChatBinding(db, "oc_test")?.pushedSeq).toBe(14);
  });
});
