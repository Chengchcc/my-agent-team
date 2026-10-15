import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatUri } from "@chengchenccc/ahp-client";
import type { ChatState } from "@microsoft/agent-host-protocol";
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

function fakeClient(snapshot: unknown, events: SubscriptionEvent[], refreshes: unknown[] = []) {
  const queue = [...events];
  return {
    connect: () => {},
    initialize: async () => ({ snapshots: [{ resource: uri, state: snapshot }] }),
    // The re-read path: each call answers with the next queued state, else the original one.
    subscribe: async () => ({
      result: { snapshot: { state: refreshes.length > 0 ? refreshes.shift() : snapshot } },
      subscription: { close: async () => {} },
    }),
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
          action: {
            type: "chat/turnStarted",
            turnId: "run-2",
            startedAt: "2026-09-29T00:00:00.000Z",
            message: { text: "go", origin: { kind: "user" } },
          },
          serverSeq: 1,
          origin: undefined,
        },
      } as never,
      {
        type: "action",
        params: {
          channel: uri,
          action: {
            type: "chat/responsePart",
            turnId: "run-2",
            part: {
              kind: "markdown",
              id: "run-2:text:0",
              content: "live",
              _meta: { messageId: "run:run-2:assistant:0" },
            },
          },
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
      // The channel already carries run-2's (empty) turn, so the live part applies through the
      // reducer. The recovery case - a channel that does NOT carry the turn - is the next test.
      clientFactory: () => {
        const base = stateWith([part("first", "run:run-1:assistant:0")]);
        return fakeClient(
          { ...base, turns: [...base.turns, { ...base.turns[0], id: "run-2", responseParts: [] }] },
          events,
        );
      },
    });
    await Bun.sleep(50);
    handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    // The snapshot's message, then the one the action stream carried: the live reply is delivered
    // as it arrives, through upstream's reducer. Both actions here are real protocol actions, so a
    // dropped or invented frame shows up as a missing send instead of passing silently.
    expect(sent).toEqual(["first", "live"]);
  });

  test("a part for a turn the state never saw re-reads the channel and recovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-ahp-w-"));
    const db: Database = openBindings("test-agent", dir);
    const sent: string[] = [];
    // The watcher's first snapshot has only run-1, the stream carries a part for run-3, and the
    // channel's own state carries run-3. Without the re-read the part is a no-op forever (the
    // protocol addresses every part by a turn the state knows) and the card only paints at the
    // fold - the "sat on thinking while tools ran" report.
    const base = stateWith([part("first", "run:run-1:assistant:0")]);
    const recovered = {
      ...base,
      turns: [
        ...base.turns,
        {
          ...base.turns[0],
          id: "run-3",
          responseParts: [
            {
              kind: "markdown",
              id: "run-3:text:0",
              content: "recovered",
              _meta: { messageId: "run:run-3:assistant:0" },
            },
          ],
        },
      ],
    };
    const events: SubscriptionEvent[] = [
      {
        type: "action",
        params: {
          channel: uri,
          action: {
            type: "chat/responsePart",
            turnId: "run-3",
            part: {
              kind: "markdown",
              id: "run-3:text:0",
              content: "recovered",
              _meta: { messageId: "run:run-3:assistant:0" },
            },
          },
          serverSeq: 1,
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
      fetchTicket: async () => ({ ticket: "t-3", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () =>
        fakeClient(stateWith([part("first", "run:run-1:assistant:0")]), events, [recovered]),
    });
    await Bun.sleep(50);
    handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(sent).toEqual(["first", "recovered"]);
  });

  test("a completed tool re-reads the channel, so the card's plan strip is not stale (#52)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-ahp-w-"));
    const db: Database = openBindings("test-agent", dir);
    const sent: string[] = [];
    const events: SubscriptionEvent[] = [
      {
        type: "action",
        params: {
          channel: uri,
          // A real action: the plan strip arrives in `state._meta.todos`, which no action can set,
          // so a completed tool has to re-read the channel for the card to show it.
          action: {
            type: "chat/toolCallComplete",
            turnId: "run-2",
            callId: "call-1",
            result: { output: "{}" },
          },
          serverSeq: 1,
          origin: undefined,
        },
      } as never,
    ];
    // The plan strip is the run card's, and the card reads the state through `onChatState`
    // (text delivery skips a chat a card owns).
    const seenStates: ChatState[] = [];
    const handle = watchConversationOverAhp("c1", "chat-1", {
      db,
      backendUrl: "http://localhost",
      backendAuthToken: "token",
      onSend: async (_chatId, text) => {
        sent.push(text);
      },
      onChatState: (state) => {
        seenStates.push(state);
      },
      fetchTicket: async () => ({ ticket: "t-3", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () =>
        fakeClient(stateWith([part("hello", "run:run-1:assistant:0")]), events, [
          // The real change is the plan strip: a DB-only fact in `state._meta.todos`.
          {
            ...stateWith([part("hello", "run:run-1:assistant:0")]),
            _meta: { todos: [{ id: "t1", text: "plan-step", status: "in_progress" }] },
          },
        ]),
    });
    await Bun.sleep(50);
    handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    // The action itself carries no plan strip, so the only thing that can put it in front of the
    // card is the re-read: the state handed to the card has to carry it.
    expect(
      (seenStates.at(-1) as { _meta?: { todos?: Array<{ text?: string }> } } | undefined)?._meta
        ?.todos,
    ).toEqual([{ id: "t1", text: "plan-step", status: "in_progress" }]);
  });
});
