import { describe, expect, test } from "bun:test";
import {
  collectHealth,
  deriveLarkHealthState,
  heartbeatPayload,
  type LarkBotHealth,
} from "./diagnostics.js";
import { verifyLarkCredentials } from "./lark-api.js";

const HEALTH: LarkBotHealth = {
  agentId: "a1",
  profileRef: "agent:a1",
  status: "running",
  watchers: { conversation: 2, runDelta: 1 },
  runStreams: {
    starting: 0,
    streaming: 0,
    done: 0,
    error: 0,
    fallbackText: 0,
    cardSendFailed: 0,
    cardUpdateFailed: 0,
  },
  lastError: null,
  pendingDeliveries: 3,
  chats: [
    {
      chatId: "oc_1",
      chatType: "group",
      chatMode: "topic",
      conversations: 2,
      topicRootMessageId: "om_root",
    },
  ],
  ts: 1_800_000_000_000,
};

describe("heartbeat payload", () => {
  test("carries pendingDeliveries — the whitelist is not the health object", () => {
    // The wire body is an explicit whitelist, so a field on LarkBotHealth
    // reaches the backend only if it is named here. It was omitted once and
    // the surface view read the queue as permanently empty.
    const payload = heartbeatPayload(HEALTH);
    expect(payload.pendingDeliveries).toBe(3);
    expect(Object.keys(payload).sort()).toEqual(
      ["chats", "pendingDeliveries", "profileRef", "runStreams", "ts", "watchers"].sort(),
    );
  });

  test("the bound-chat mirror rides the payload for the backend to store", () => {
    const payload = heartbeatPayload(HEALTH);
    expect(payload.chats).toEqual(HEALTH.chats);
  });

  test("reporting a queue is a flat number the backend can flatten", () => {
    // The backend lifts top-level numbers into counters; a nested object
    // would silently never appear as a counter.
    expect(typeof heartbeatPayload(HEALTH).pendingDeliveries).toBe("number");
  });
});

describe("collectHealth", () => {
  test("degraded iff there is a lastError, and it reports the pending queue", () => {
    const clean = collectHealth("a1", "agent:a1", { conversation: 2, runDelta: 0 }, null, 0, []);
    expect(clean.status).toBe("running");
    expect(clean.pendingDeliveries).toBe(0);

    const sad = collectHealth("a1", "agent:a1", { conversation: 2, runDelta: 0 }, "boom", 7, []);
    expect(sad.status).toBe("degraded");
    expect(sad.lastError).toBe("boom");
    expect(sad.pendingDeliveries).toBe(7);

    const err = collectHealth(
      "a1",
      "agent:a1",
      { conversation: 2, runDelta: 0 },
      "invalid secret",
      0,
      [],
      "error",
    );
    expect(err.status).toBe("error");
    expect(err.lastError).toBe("invalid secret");
  });
});

describe("deriveLarkHealthState", () => {
  test("reports running only when connected with no auth or transport error", () => {
    expect(
      deriveLarkHealthState({
        wsState: "connected",
        everConnected: true,
        authError: null,
        channelError: null,
        unrecoverableError: null,
      }),
    ).toEqual({ status: "running", lastError: null });
  });

  test("authError forces error even while an older WS still looks connected", () => {
    expect(
      deriveLarkHealthState({
        wsState: "connected",
        everConnected: true,
        authError: "Lark auth failed: code 10014 invalid app secret",
        channelError: null,
        unrecoverableError: null,
      }),
    ).toEqual({
      status: "error",
      lastError: "Lark auth failed: code 10014 invalid app secret",
    });
  });

  test("never reports running before initial connect completes", () => {
    const res = deriveLarkHealthState({
      wsState: "connecting",
      everConnected: false,
      authError: null,
      channelError: null,
      unrecoverableError: null,
    });
    expect(res.status).toBe("degraded");
    expect(res.lastError).toContain("not connected");
  });

  test("reconnecting WS reports degraded, unrecoverable reports error", () => {
    expect(
      deriveLarkHealthState({
        wsState: "reconnecting",
        everConnected: true,
        authError: null,
        channelError: null,
        unrecoverableError: null,
      }),
    ).toEqual({ status: "degraded", lastError: "Lark WebSocket reconnecting" });

    expect(
      deriveLarkHealthState({
        wsState: "disconnected",
        everConnected: true,
        authError: null,
        channelError: null,
        unrecoverableError: "Lark WebSocket unrecoverable",
      }),
    ).toEqual({ status: "error", lastError: "Lark WebSocket unrecoverable" });
  });
});

describe("verifyLarkCredentials", () => {
  test("returns ok on code 0 and surfaces exact error on rotated/invalid secret", async () => {
    const okRes = await verifyLarkCredentials(
      { appId: "cli_1", appSecret: "good", baseUrl: "https://open.feishu.cn" },
      (async () =>
        Response.json({
          code: 0,
          tenant_access_token: "t-abc",
          expire: 7200,
        })) as unknown as typeof fetch,
    );
    expect(okRes).toEqual({ ok: true });

    const badRes = await verifyLarkCredentials(
      { appId: "cli_1", appSecret: "stale", baseUrl: "https://open.feishu.cn" },
      (async () =>
        Response.json({ code: 10014, msg: "app secret invalid" })) as unknown as typeof fetch,
    );
    expect(badRes).toEqual({
      ok: false,
      error: "Lark auth failed: code 10014 app secret invalid",
    });
  });
});
