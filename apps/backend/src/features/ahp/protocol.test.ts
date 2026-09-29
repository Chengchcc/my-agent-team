/** 互操作用例：官方 TS 客户端连我们的服务端核心（ADR 0040 决策二的升级闸门）。
 *  传输用上游的内存对，不需要端口。 */
import { describe, expect, test } from "bun:test";
import type { SessionLifecycle, SessionStatus } from "@microsoft/agent-host-protocol";
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
    root: () => ({ agents: [{ id: "agent-1", name: "oma", title: "oma" } as never] }),
    session: () => ({
      provider: "my-agent-team",
      title: "session",
      status: 1 as SessionStatus, // SessionStatus.Idle
      lifecycle: "ready" as SessionLifecycle,
      activeClients: [],
      chats: [],
    }),
    chat: (uri) => ({
      resource: uri,
      title: "chat",
      status: 1 as SessionStatus, // SessionStatus.Idle
      modifiedAt: "2026-09-29T00:00:00.000Z",
      turns: [],
    }),
  };
}

/** 把内存传输的一半接到服务端连接上。 */
function connect(server: AhpServer) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  // `received` 记的是服务端**发出**的帧（在 send 回调里），drain 循环只负责把
  // 客户端发来的帧喂进 handle。
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

  test("a client-dispatched action applies on both sides", async () => {
    const server = createAhpServer({ source: fakeSource() });
    const { client } = await handshake(server);
    const { result, subscription } = await client.subscribe(SESSION_URI);
    const mirror = new AhpStateMirror();
    mirror.applySnapshot(result.snapshot!);
    // 订阅的事件流要有人读：动作信封才是把镜像推到新状态的东西。
    const consume = (async () => {
      for await (const event of subscription) {
        if (event.type === "action") mirror.apply(event.params);
      }
    })();

    // 客户端派发 → 服务端用同一个 reducer 应用 → 动作流回到客户端再应用一次。
    client.dispatch(SESSION_URI, {
      type: "session/titleChanged",
      title: "renamed",
    } as never);
    await Bun.sleep(10);

    expect(mirror.sessions.get(SESSION_URI)?.title).toBe("renamed");
    // 服务端自己的状态也变了：再订阅一次拿到的是推进后的快照。
    const after = await client.subscribe(SESSION_URI);
    expect((after.result.snapshot?.state as { title?: string }).title).toBe("renamed");
    expect(server.serverSeq).toBeGreaterThanOrEqual(1);
    await after.subscription.close();
    await subscription.close();
    // 消费循环是旁路：它的结束与否不该决定用例结果。
    void consume.catch(() => undefined);
    await client.shutdown();
  });

  test("an action a client may not dispatch is echoed with a reason", async () => {
    const server = createAhpServer({ source: fakeSource() });
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
    const server = createAhpServer({ source: fakeSource(), replayBufferSize: 2 });
    const { client } = await handshake(server);
    const seen = server.serverSeq;
    for (const title of ["a", "b"]) {
      server.dispatch(SESSION_URI, { type: "session/titleChanged", title } as never);
    }
    const replay = (await client.reconnect({
      clientId: "test-client",
      lastSeenServerSeq: seen,
      subscriptions: [SESSION_URI],
    })) as { type: string; actions?: unknown[] };
    expect(replay.type).toBe("replay");
    expect(replay.actions).toHaveLength(2);

    // 差距超出缓冲：回快照而不是无限重放。
    for (const title of ["c", "d", "e"]) {
      server.dispatch(SESSION_URI, { type: "session/titleChanged", title } as never);
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
