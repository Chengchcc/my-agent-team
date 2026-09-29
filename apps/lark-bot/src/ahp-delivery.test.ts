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
