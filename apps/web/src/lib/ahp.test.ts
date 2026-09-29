import { describe, expect, test } from "bun:test";
import { chatUri } from "@chengchenccc/ahp-client";
import type { ChatState } from "@microsoft/agent-host-protocol";
import type { AhpTransport, SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import { connectAhpChat } from "./ahp.js";

const uri = chatUri("c1");

const stateWith = (title: string): ChatState =>
  ({
    resource: uri,
    title,
    status: 1,
    modifiedAt: new Date(0).toISOString(),
    turns: [],
  }) as ChatState;

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

describe("web surface over AHP", () => {
  test("the chat snapshot reaches the caller", async () => {
    const seen: string[] = [];
    const connection = connectAhpChat({
      conversationId: "c1",
      onChange: (state) => seen.push(state.title),
      fetchTicket: async () => ({ ticket: "t-1", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () => fakeClient(stateWith("snapshot"), []),
    });
    await Bun.sleep(30);
    connection.close();
    expect(seen).toEqual(["snapshot"]);
  });

  test("an action is reduced and re-emitted", async () => {
    const seen: string[] = [];
    const events: SubscriptionEvent[] = [
      {
        type: "action",
        params: {
          channel: uri,
          // A real action, in the shape upstream's own vectors use - not an invented one.
          action: {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: new Date(0).toISOString(),
            message: { text: "go", origin: { kind: "user" } },
          },
          serverSeq: 1,
        },
      } as never,
    ];
    const connection = connectAhpChat({
      conversationId: "c1",
      onChange: (state) => seen.push(state.activeTurn?.id ?? "-"),
      fetchTicket: async () => ({ ticket: "t-2", wsBase: "ws://localhost" }),
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () => fakeClient(stateWith("snapshot"), events),
    });
    await Bun.sleep(30);
    connection.close();
    expect(seen).toEqual(["-", "turn-1"]);
  });

  test("a failed ticket request is reported instead of thrown", async () => {
    const errors: unknown[] = [];
    const connection = connectAhpChat({
      conversationId: "c1",
      onChange: () => {},
      onError: (err) => errors.push(err),
      fetchTicket: async () => {
        throw new Error("ticket blew up");
      },
      reconnectDelayMs: 5,
      transportFactory: () => ({}) as AhpTransport,
      clientFactory: () => fakeClient(stateWith("snapshot"), []),
    });
    await Bun.sleep(30);
    connection.close();
    expect(errors.length).toBeGreaterThan(0);
  });
});
