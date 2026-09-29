import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatUri } from "@chengchenccc/ahp-client";
import type { AhpTransport, SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import { watchConversationOverAhp } from "./ahp-watcher.js";
import { openBindings } from "./bindings-sqlite.js";

const uri = chatUri("c1");

const stateWith = (parts: unknown[]) => ({
  resource: uri,
  title: "t",
  status: 1,
  modifiedAt: new Date(0).toISOString(),
  turns: [
    {
      id: "run-1",
      startedAt: new Date(0).toISOString(),
      message: { text: "go", origin: { kind: "user" } },
      responseParts: parts,
      usage: undefined,
      state: "complete",
    },
  ],
});

const part = (text: string, messageId: string) => ({
  kind: "markdown",
  id: "run-1:text:0",
  content: text,
  _meta: { messageId },
});

function fakeClient(snapshot: unknown, events: SubscriptionEvent[]) {
  const queue = [...events];
  return {
    connect: () => {},
    initialize: async () => ({ snapshots: [{ resource: uri, state: snapshot }] }),
    attachSubscription: () =>
      ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: async () =>
          queue.length > 0
            ? { done: false as const, value: queue.shift()! }
            : { done: true as const, value: undefined },
      }) as never,
    shutdown: async () => {},
  };
}

describe("watching a conversation over AHP", () => {
  test("the initial snapshot is delivered to Lark", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-ahp-w-"));
    const db: Database = openBindings("test-agent", dir);
    const sent: string[] = [];
    const handle = watchConversationOverAhp("c1", "chat-1", {
      db,
      backendUrl: "http://localhost",
      backendAuthToken: null,
      onSend: async (_chatId, text) => {
        sent.push(text);
      },
      fetchTicket: async () => ({ ticket: "t-1", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () => fakeClient(stateWith([part("hello", "run:run-1:assistant:0")]), []),
    });
    await Bun.sleep(50);
    handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(sent).toEqual(["hello"]);
  });

  test("an action event is applied and its result delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-ahp-w-"));
    const db: Database = openBindings("test-agent", dir);
    const sent: string[] = [];
    const events: SubscriptionEvent[] = [
      {
        type: "action",
        params: {
          channel: uri,
          action: { type: "chat/titleChanged", title: "renamed" },
          serverSeq: 1,
          origin: undefined,
        },
      } as never,
      {
        type: "action",
        params: {
          channel: uri,
          action: { type: "chat/turnStarted", turnId: "run-2", startedAt: "t", message: {} },
          serverSeq: 2,
          origin: undefined,
        },
      } as never,
    ];
    const handle = watchConversationOverAhp("c1", "chat-1", {
      db,
      backendUrl: "http://localhost",
      backendAuthToken: "token",
      onSend: async (_chatId, text) => {
        sent.push(text);
      },
      fetchTicket: async () => ({ ticket: "t-2", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () => fakeClient(stateWith([part("first", "run:run-1:assistant:0")]), events),
    });
    await Bun.sleep(50);
    handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    // The snapshot's message is delivered once; upstream's reducer applies the actions, which
    // here produce no new text to send. What this pins is that the plumbing survives them.
    expect(sent).toEqual(["first"]);
  });
});
