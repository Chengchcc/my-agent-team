import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { deliverChatState } from "./ahp-delivery.js";
import { getMessageDelivery, openBindings, upsertMessageDelivery } from "./bindings-sqlite.js";

let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lark-ahp-"));
  db = openBindings("test-agent", dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const target = { conversationId: "c1", larkChatId: "chat-1" };

const stateWith = (parts: unknown[]): ChatState =>
  ({
    resource: "ahp-chat:/c1",
    title: "t",
    status: 1 as never,
    modifiedAt: new Date(0).toISOString(),
    turns: [
      {
        id: "run-1",
        startedAt: new Date(0).toISOString(),
        message: { text: "go", origin: { kind: "user" as never } },
        responseParts: parts as never,
        usage: undefined,
        state: "complete" as never,
      },
    ],
  }) as ChatState;

const part = (text: string, messageId: string) => ({
  kind: "markdown",
  id: "run-1:text:0",
  content: text,
  _meta: { messageId },
});

describe("AHP delivery to Lark", () => {
  test("a new assistant part is delivered exactly once", async () => {
    const sent: string[] = [];
    const deps = {
      db,
      onSend: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    };
    const state = stateWith([part("hello", "run:run-1:assistant:0")]);
    await deliverChatState(state, target, deps);
    expect(sent).toEqual(["hello"]);
    // Re-running the same state: the terminal row in the delivery table stops it.
    await deliverChatState(state, target, deps);
    expect(sent).toEqual(["hello"]);
  });

  test("an interrupted delivery is replayed rather than dropped", async () => {
    const sent: string[] = [];
    const deps = {
      db,
      onSend: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    };
    upsertMessageDelivery(db, {
      conversationId: "c1",
      messageId: "run:run-1:assistant:0",
      larkChatId: "chat-1",
      lastState: "streaming",
      lastSeq: 0,
      updatedAt: Date.now(),
    });
    await deliverChatState(stateWith([part("hi", "run:run-1:assistant:0")]), target, deps);
    expect(sent).toEqual(["hi"]);
  });
});

describe("a failed send", () => {
  test("is recorded as a failure and retried on the next pass", async () => {
    const parts = [part("hello", "run-1:assistant:0")];
    const sent: string[] = [];
    const failing = {
      db,
      onSend: async (_chatId: string, text: string) => {
        sent.push(text);
        throw new Error("lark said no");
      },
    };
    // The failure leaves the delivery, because that is what makes the watcher reconnect and retry.
    await expect(deliverChatState(stateWith(parts), target, failing)).rejects.toThrow(
      "lark said no",
    );

    const row = getMessageDelivery(
      db,
      target.conversationId,
      "run-1:assistant:0",
      target.larkChatId,
    );
    // Not "done": the message never landed, and claiming it did would drop the reply.
    expect(row?.lastState).toBe("error");

    const working = {
      db,
      onSend: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    };
    await deliverChatState(stateWith(parts), target, working);
    expect(sent).toEqual(["hello", "hello"]);
    expect(
      getMessageDelivery(db, target.conversationId, "run-1:assistant:0", target.larkChatId)
        ?.lastState,
    ).toBe("done");

    // And a delivered row stays closed: a third pass sends nothing.
    await deliverChatState(stateWith(parts), target, working);
    expect(sent).toEqual(["hello", "hello"]);
  });
});

describe("AHP delivery of produced images (#65 output direction)", () => {
  const imagePart = (uri: string, contentType = "image/png") => ({
    kind: "contentRef",
    id: "run-1:image:0",
    uri,
    contentType,
    sizeHint: 2048,
    _meta: { messageId: "run:run-1:assistant:0" },
  });
  const uri = "artifacts://tool-images/c1/run-1-shot.png";

  test("an image part goes to the transport owner, keyed by its artifact uri", async () => {
    const sent: [string, string, string][] = [];
    const deps = {
      db,
      onSend: async () => {},
      onSendImage: async (chatId: string, u: string, filename: string) => {
        sent.push([chatId, u, filename]);
      },
    };
    const state = stateWith([imagePart(uri)]);
    await deliverChatState(state, target, deps);
    expect(sent).toEqual([["chat-1", uri, "run-1-shot.png"]]);
    // Every responsePart is re-delivered on reconnect; the row makes that a no-op.
    await deliverChatState(state, target, deps);
    expect(sent.length).toBe(1);
  });

  test("a failed image send is recorded and replayed, not swallowed", async () => {
    let attempts = 0;
    const deps = {
      db,
      onSend: async () => {},
      onSendImage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("feishu down");
      },
    };
    const state = stateWith([imagePart(uri)]);
    await expect(deliverChatState(state, target, deps)).rejects.toThrow("feishu down");
    expect(getMessageDelivery(db, "c1", uri, "chat-1")?.lastState).toBe("error");
    await deliverChatState(state, target, deps);
    expect(attempts).toBe(2);
  });

  test("only images travel this way", async () => {
    let calls = 0;
    const deps = {
      db,
      onSend: async () => {},
      onSendImage: async () => {
        calls += 1;
      },
    };
    await deliverChatState(
      stateWith([imagePart("artifacts://reports/c1/nightly.pdf", "application/pdf")]),
      target,
      deps,
    );
    expect(calls).toBe(0);
  });

  test("a text-only channel skips image parts without recording them", async () => {
    await deliverChatState(stateWith([imagePart(uri)]), target, { db, onSend: async () => {} });
    expect(getMessageDelivery(db, "c1", uri, "chat-1")).toBeNull();
  });
});
