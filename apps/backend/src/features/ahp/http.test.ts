/** 面挂载点的路由级向量：票制入口与「产品侧持有 server」这两件事。 */
import { describe, expect, test } from "bun:test";
import type { SessionLifecycle, SessionStatus } from "@microsoft/agent-host-protocol";
import { type AhpFaceOptions, createAhpFace } from "./http.js";

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
