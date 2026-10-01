/** Interop vectors: the official TS client against our server core (the upgrade gate of
 *  ADR 0040 decision 2). The transport is upstream's in-memory pair, so no port is needed. */
import { describe, expect, test } from "bun:test";
import type { SessionLifecycle, SessionStatus, URI } from "@microsoft/agent-host-protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import {
  AhpClient,
  AhpStateMirror,
  InMemoryTransport,
} from "@microsoft/agent-host-protocol/client";
import { AHP_ROOT, type AhpServer, type AhpStateSource, createAhpServer } from "./protocol.js";

const SESSION_URI = "ahp-session:/s1";
const CHAT_URI = "ahp-chat:/c1";

/** The command port: records client commands and optionally applies them to channel state,
 *  standing in for the product side. */
function createPort(onSubmit?: (command: { channel: string; action: unknown }) => void) {
  const calls: Array<{ channel: string; action: unknown; origin: unknown }> = [];
  const port = {
    submit: (command: { channel: string; action: unknown; origin: unknown }) => {
      calls.push(command);
      onSubmit?.(command);
    },
  };
  return { calls, port };
}

const noopPort = { submit: () => undefined };

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
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
    const { client, init } = await handshake(server);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(init.protocolVersion as never);
    expect(init.snapshots.map((s) => s.resource)).toEqual([AHP_ROOT]);
    const mirror = new AhpStateMirror();
    for (const snapshot of init.snapshots) mirror.applySnapshot(snapshot);
    expect(mirror.root?.agents).toHaveLength(1);
    await client.shutdown();
  });

  test("an unserved channel is refused instead of fabricating empty state", async () => {
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
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
      commands: noopPort,
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
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
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
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(SESSION_URI);
    expect(result.snapshot?.resource).toBe(SESSION_URI);
    expect((result.snapshot?.state as { provider?: string }).provider).toBe("my-agent-team");
    await subscription.close();
    await client.shutdown();
  });

  test("a chat channel snapshot is served (the HITL channel)", async () => {
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(CHAT_URI);
    expect(result.snapshot?.resource).toBe(CHAT_URI);
    expect((result.snapshot?.state as { turns?: unknown[] }).turns).toEqual([]);
    await subscription.close();
    await client.shutdown();
  });

  test("a client-dispatched action reaches the port instead of moving state here", async () => {
    const { port, calls } = createPort();
    const server = createAhpServer({ source: fakeSource(), commands: port });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(SESSION_URI);
    const mirror = new AhpStateMirror();
    mirror.applySnapshot(result.snapshot!);
    const consume = (async () => {
      for await (const event of subscription) {
        if (event.type === "action") mirror.apply(event.params);
      }
    })();

    client.dispatch(SESSION_URI, {
      type: "session/titleChanged",
      title: "renamed",
    } as never);
    await Bun.sleep(10);

    // The command reaches the product side with its origin; the protocol module does not touch
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe(SESSION_URI);
    expect(calls[0]?.action).toMatchObject({ type: "session/titleChanged", title: "renamed" });
    expect(calls[0]?.origin).toMatchObject({ clientId: "test-client" });
    expect(mirror.sessions.get(SESSION_URI)?.title).toBe("session");
    const stillOld = await client.subscribe(SESSION_URI);
    expect((stillOld.result.snapshot?.state as { title?: string }).title).toBe("session");

    // this channel's state itself. It dispatches the result, and both ends converge.
    await server.dispatch(SESSION_URI, { type: "session/titleChanged", title: "renamed" } as never);
    await Bun.sleep(10);
    expect(mirror.sessions.get(SESSION_URI)?.title).toBe("renamed");

    await stillOld.subscription.close();
    await subscription.close();
    void consume.catch(() => undefined);
    await client.shutdown();
  });

  test("a port that refuses the command is echoed as a rejection", async () => {
    const server = createAhpServer({
      source: fakeSource(),
      commands: {
        submit: () => {
          throw new Error("run is not accepting inputs");
        },
      },
    });
    const { client } = await handshake(server);
    const { subscription } = await client.subscribe(SESSION_URI);
    const seen: Array<{ channel: URI; rejectionReason?: string }> = [];
    const consume = (async () => {
      for await (const event of subscription) {
        if (event.type === "action") {
          seen.push(event.params as { channel: URI; rejectionReason?: string });
        }
      }
    })();

    client.dispatch(SESSION_URI, { type: "session/titleChanged", title: "x" } as never);
    await Bun.sleep(10);
    expect(seen[0]?.rejectionReason).toContain("not accepting inputs");

    await subscription.close();
    void consume.catch(() => undefined);
    await client.shutdown();
  });

  test("an action a client may not dispatch is echoed with a reason", async () => {
    const server = createAhpServer({ source: fakeSource(), commands: noopPort });
    const { connection, received } = connect(server);
    connection.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          channel: AHP_ROOT,
          clientId: "x",
          protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        },
      }),
    );
    await Bun.sleep(5);
    connection.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "dispatchAction",
        params: {
          channel: SESSION_URI,
          clientSeq: 1,
          action: { type: "session/ready" },
        },
      }),
    );
    await Bun.sleep(5);
    const echo = JSON.parse(received.at(-1)!) as {
      method?: string;
      params?: { rejectionReason?: string };
    };
    expect(echo.method).toBe("action");
    expect(echo.params?.rejectionReason).toContain("not client-dispatchable");
  });

  test("reconnect replays inside the buffer and falls back to a snapshot outside it", async () => {
    const server = createAhpServer({
      source: fakeSource(),
      commands: noopPort,
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
