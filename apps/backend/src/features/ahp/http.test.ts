/** Route-level vectors for the mount point: the ticket endpoint, and the product side holding
 *  the server. */
import { describe, expect, test } from "bun:test";
import type { SessionLifecycle, SessionStatus } from "@microsoft/agent-host-protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { Elysia } from "elysia";
import { type AhpFaceOptions, createAhpFace } from "./http.js";
import { AHP_ROOT } from "./protocol.js";

const SESSION_URI = "ahp-session:/s1";

const source: AhpFaceOptions["source"] = {
  root: async () => ({ agents: [] }),
  session: async () => ({
    provider: "my-agent-team",
    title: "session",
    status: 1 as SessionStatus, // SessionStatus.Idle
    lifecycle: "ready" as SessionLifecycle,
    activeClients: [],
    chats: [],
  }),
  chat: async () => undefined,
};

const faceWith = (over: Partial<AhpFaceOptions> = {}) =>
  createAhpFace({
    source,
    commands: { submit: () => undefined },
    wsBase: "ws://127.0.0.1:3000",
    ...over,
  });

describe("AHP face routes", () => {
  test("the ticket route mints a ticket and names the ws endpoint", async () => {
    const face = faceWith();
    const res = await face.routes.handle(
      new Request("http://localhost/api/ahp/ws-ticket", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; wsBase: string };
    expect(body.wsBase).toBe("ws://127.0.0.1:3000");
    expect(body.ticket).toHaveLength(64);
  });

  test("the product side holds the server and can dispatch into it", async () => {
    const face = faceWith();
    const envelope = await face.server.dispatch(SESSION_URI, {
      type: "session/titleChanged",
      title: "renamed",
    } as never);
    expect(envelope.channel).toBe(SESSION_URI);
    expect(envelope.serverSeq).toBe(1);
  });
});

/** A real WS round trip: the ticket gates the upgrade, and a ticketed connection completes an
 *  initialize handshake. Unit tests cannot reach Elysia's ws lifecycle; only a real connect can. */
describe("AHP face over a real websocket", () => {
  test("no ticket is refused; a minted ticket gets a root snapshot", async () => {
    const face = faceWith();
    const app = new Elysia().use(face.routes).listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const port = (app.server as { port: number }).port;

      const refused = new WebSocket(`ws://127.0.0.1:${port}/ws/ahp`);
      const refusedCode = await new Promise<number>((resolve) => {
        refused.addEventListener("close", (event) => resolve((event as CloseEvent).code));
        refused.addEventListener("error", () => resolve(-1));
      });
      expect(refusedCode).toBe(4001);

      const minted = await app.handle(
        new Request("http://localhost/api/ahp/ws-ticket", { method: "POST" }),
      );
      const { ticket } = (await minted.json()) as { ticket: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ahp?ticket=${ticket}`);
      const first = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                channel: AHP_ROOT,
                clientId: "ws-test",
                protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
                initialSubscriptions: [AHP_ROOT],
              },
            }),
          );
        });
        socket.addEventListener("message", (event) =>
          resolve(String((event as MessageEvent).data)),
        );
        socket.addEventListener("error", () => reject(new Error("socket error")));
      });
      const reply = JSON.parse(first) as {
        result?: { snapshots?: Array<{ resource: string }> };
      };
      expect(reply.result?.snapshots?.[0]?.resource).toBe(AHP_ROOT);
      socket.close();

      // The ticket is one-shot: the same ticket a second time must be refused.
      const replay = new WebSocket(`ws://127.0.0.1:${port}/ws/ahp?ticket=${ticket}`);
      const replayCode = await new Promise<number>((resolve) => {
        replay.addEventListener("close", (event) => resolve((event as CloseEvent).code));
        replay.addEventListener("error", () => resolve(-1));
      });
      expect(replayCode).toBe(4001);
    } finally {
      // A graceful stop waits for connections, so stop the server forcibly in a test.
      (app.server as { stop?: (force?: boolean) => void } | null)?.stop?.(true);
      await app.stop().catch(() => undefined);
    }
  }, 20_000);
});
