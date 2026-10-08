/** Interop vectors: the official TS client against our server core (the upgrade gate of
 *  ADR 0040 decision 2). The transport is upstream's in-memory pair, so no port is needed. */
import { describe, expect, test } from "bun:test";
import type {
  ChatState,
  SessionLifecycle,
  SessionStatus,
  URI,
} from "@microsoft/agent-host-protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import {
  AhpClient,
  AhpStateMirror,
  InMemoryTransport,
} from "@microsoft/agent-host-protocol/client";
import { AHP_ROOT, type AhpServer, type AhpStateSource, createAhpServer } from "./protocol.js";

const SESSION_URI = "ahp-session:/s1";
const CHAT_URI = "ahp-chat:/c1";

function fakeSource(): AhpStateSource {
  return {
    root: async () => ({ agents: [{ id: "agent-1", name: "oma", title: "oma" } as never] }),
    session: async () => ({
      provider: "my-agent-team",
      title: "session",
      status: 1 as SessionStatus, // SessionStatus.Idle
      lifecycle: "ready" as SessionLifecycle,
      activeClients: [],
      chats: [],
    }),
    chat: async (uri) => ({
      resource: uri,
      title: "chat",
      status: 1 as SessionStatus, // SessionStatus.Idle
      modifiedAt: "2026-09-29T00:00:00.000Z",
      turns: [],
    }),
  };
}

/** Wires one half of the in-memory transport to a server connection. */
function connect(server: AhpServer) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  // `received` records the frames the server **sends** (in the send callback); the drain loop
  // only feeds frames the client sends into `handle`.
  const received: string[] = [];
  const connection = server.createConnection((frame) => {
    received.push(frame);
    void serverSide.send(frame);
  });
  void (async () => {
    for (;;) {
      const frame = await serverSide.recv();
      if (frame === null) break;
      connection.handle(
        frame.kind === "text"
          ? frame.text
          : frame.kind === "binary"
            ? new TextDecoder().decode(frame.data)
            : JSON.stringify(frame.message),
      );
    }
  })();
  return { clientSide, connection, received };
}

async function handshake(server: AhpServer) {
  const { clientSide, connection, received } = connect(server);
  const client = new AhpClient(clientSide);
  client.connect();
  const init = await client.initialize({
    clientId: "test-client",
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    initialSubscriptions: [AHP_ROOT],
  });
  return { client, connection, received, init };
}

describe("AHP server core against the official client", () => {
  test("handshake negotiates a version and ships the root snapshot", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { client, init } = await handshake(server);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(init.protocolVersion as never);
    expect(init.snapshots.map((s) => s.resource)).toEqual([AHP_ROOT]);
    const mirror = new AhpStateMirror();
    for (const snapshot of init.snapshots) mirror.applySnapshot(snapshot);
    expect(mirror.root?.agents).toHaveLength(1);
    await client.shutdown();
  });

  test("an unserved channel is refused instead of fabricating empty state", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { connection, received } = connect(server);
    connection.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientId: "x",
          protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          initialSubscriptions: ["ahp-terminal:/nope"],
        },
      }),
    );
    await Bun.sleep(5);
    const reply = JSON.parse(received.at(-1)!) as { error?: { code: number } };
    // AhpErrorCodes.InvalidParams: we do not serve this channel kind at all.
    expect(reply.error?.code).toBe(-32602);
    expect(connection.subscriptions.size).toBe(0);
  });

  test("an unknown session is NotFound, not a cached empty state", async () => {
    const server = createAhpServer({
      source: {
        root: async () => ({ agents: [] }),
        session: async () => undefined,
        chat: async () => undefined,
      },
    });
    const { connection, received } = connect(server);
    connection.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscribe",
        params: { channel: "ahp-session:/missing" },
      }),
    );
    await Bun.sleep(5);
    const reply = JSON.parse(received.at(-1)!) as { error?: { code: number }; result?: unknown };
    // AhpErrorCodes.NotFound.
    expect(reply.error?.code).toBe(-32008);
    expect(reply.result).toBeUndefined();
    expect(connection.subscriptions.size).toBe(0);
  });

  test("an unsupported version offer is refused with the supported list", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { connection, received } = connect(server);
    connection.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { channel: AHP_ROOT, clientId: "x", protocolVersions: ["9.9.9"] },
      }),
    );
    await Bun.sleep(5);
    const reply = JSON.parse(received.at(-1)!) as {
      error?: { code?: number; data?: { supportedVersions?: string[] } };
    };
    expect(reply.error?.code).toBe(-32005);
    expect(reply.error?.data?.supportedVersions).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  test("subscribing a session channel returns its snapshot", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(SESSION_URI);
    expect(result.snapshot?.resource).toBe(SESSION_URI);
    expect((result.snapshot?.state as { provider?: string }).provider).toBe("my-agent-team");
    await subscription.close();
    await client.shutdown();
  });

  test("a chat channel snapshot is served (the HITL channel)", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(CHAT_URI);
    expect(result.snapshot?.resource).toBe(CHAT_URI);
    expect((result.snapshot?.state as { turns?: unknown[] }).turns).toEqual([]);
    await subscription.close();
    await client.shutdown();
  });

  test("reconnect replays inside the buffer and falls back to a snapshot outside it", async () => {
    const server = createAhpServer({
      source: fakeSource(),

      replayBufferSize: 2,
    });
    const { client } = await handshake(server);
    const seen = server.serverSeq;
    for (const title of ["a", "b"]) {
      await server.dispatch(SESSION_URI, { type: "session/titleChanged", title } as never);
    }
    const replay = (await client.reconnect({
      clientId: "test-client",
      lastSeenServerSeq: seen,
      subscriptions: [SESSION_URI],
    })) as { type: string; actions?: unknown[] };
    expect(replay.type).toBe("replay");
    expect(replay.actions).toHaveLength(2);

    // Gap beyond the buffer: fall back to a snapshot instead of replaying without bound.
    for (const title of ["c", "d", "e"]) {
      await server.dispatch(SESSION_URI, { type: "session/titleChanged", title } as never);
    }
    const fallback = (await client.reconnect({
      clientId: "test-client",
      lastSeenServerSeq: seen,
      subscriptions: [SESSION_URI],
    })) as { type: string; snapshots?: unknown[] };
    expect(fallback.type).toBe("snapshot");
    expect(fallback.snapshots).toHaveLength(1);
    await client.shutdown();
  });
});

// #52 (the AHP revision model). The case: a DB-only write (todo snapshot,
// commit_failed, undo) has no StateAction to carry it, and `seed()` caches the
// projection — so the cache diverges from the DB for the life of the process.
// Two live surfaces read it (web TodoPanel via useConversation.setRunTodos,
// Lark's run card via parseTodoItems), and the run-event feed that used to
// carry todos live is being retired. `invalidate` is the write site's hook.
test("invalidate drops the cached projection so the next read sees the DB truth", async () => {
  let todos: unknown[] = [{ id: "t1", text: "first", status: "in_progress" }];
  const base = fakeSource();
  const source: AhpStateSource = {
    ...base,
    chat: async (uri: URI): Promise<ChatState | undefined> => {
      const baseState = await base.chat(uri);
      return baseState ? { ...baseState, _meta: { todos } } : undefined;
    },
  };
  const server = createAhpServer({ source });
  const { client } = await handshake(server);
  const todosOf = (snapshot: { state?: unknown } | undefined) =>
    (snapshot?.state as { _meta?: { todos?: unknown[] } } | undefined)?._meta?.todos;

  const first = await client.subscribe(CHAT_URI);
  expect(todosOf(first.result.snapshot)).toHaveLength(1);

  // A DB-only change: nothing dispatches, so nothing tells the surface.
  todos = [
    { id: "t1", text: "first" },
    { id: "t2", text: "second" },
  ];

  // Without invalidation the cache answers — this is the divergence.
  const stale = await client.subscribe(CHAT_URI);
  expect(todosOf(stale.result.snapshot)).toHaveLength(1);

  server.invalidate(CHAT_URI);
  const fresh = await client.subscribe(CHAT_URI);
  expect(todosOf(fresh.result.snapshot)).toHaveLength(2);

  await client.shutdown();
});

describe("#28: the subscription handshake is atomic with dispatches", () => {
  /** A source whose chat read hangs until the test releases it: the dispatch
   *  below then lands exactly in the gap the race lives in. */
  function gatedSource() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeSource();
    const src: AhpStateSource = {
      ...base,
      chat: async (uri: URI) => {
        await gate;
        return base.chat(uri);
      },
    };
    return { src, release };
  }

  test("an action dispatched during the initialize snapshot still reaches the client", async () => {
    const { src, release } = gatedSource();
    const server = createAhpServer({ source: src });
    const { connection, received } = connect(server);
    // initialize subscribes to the chat channel; its snapshot read now hangs.
    const pending = new Promise<void>((resolve) => {
      void (async () => {
        connection.handle(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "initialize",
            params: {
              channel: "ahp-root://",
              clientId: "race-client",
              protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
              initialSubscriptions: [CHAT_URI],
            },
          }),
        );
        resolve();
      })();
    });
    await pending;
    // Let the handshake reach its await, then dispatch into the gap.
    await Bun.sleep(20);
    server.dispatch(CHAT_URI, { type: "chat/turnStarted", turnId: "t-race" } as never);
    await Bun.sleep(20);
    release();

    // Wait for the initialize response, then assert the action arrived.
    let sawInit = false;
    let sawAction = false;
    for (let i = 0; i < 50 && !(sawInit && sawAction); i++) {
      for (const frame of received) {
        if (frame.includes('"id":7')) sawInit = true;
        if (frame.includes("t-race")) sawAction = true;
      }
      if (!(sawInit && sawAction)) await Bun.sleep(10);
    }
    expect(sawInit).toBe(true);
    expect(sawAction).toBe(true);
  });
});
