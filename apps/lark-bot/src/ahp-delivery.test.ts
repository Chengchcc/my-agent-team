import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { deliverChatState } from "./ahp-delivery.js";
import { openBindings, upsertMessageDelivery } from "./bindings-sqlite.js";

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
    // 同一份状态再跑一遍：投递表里的终态把它挡住了。
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
