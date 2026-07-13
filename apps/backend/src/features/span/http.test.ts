import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  fakeGetSessionIdByRunId,
  fakeSessionManager,
  TID,
} from "../../../test-helpers/mock-deps.js";
import { resumeRoutes } from "./http.js";

function buildRequest(rid: string, body: unknown): Request {
  return new Request(`http://localhost/api/runs/${rid}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeApp(deps: {
  sessionManager: ReturnType<typeof fakeSessionManager>;
  getSessionIdByRunId: (spanId: string) => string | null;
}) {
  return new Elysia().use(resumeRoutes(deps as unknown as Parameters<typeof resumeRoutes>[0]));
}

describe("resumeRoute", () => {
  test("returns 404 when spanId not found", async () => {
    const sm = fakeSessionManager();
    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await app.handle(buildRequest(TID.run(), { approved: true }));
    expect(res.status).toBe(404);
  });

  test("returns 409 when session no longer active", async () => {
    const sm = fakeSessionManager();
    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [TID.run()]: TID.session() }),
    });
    // session not created → get returns undefined → 409
    const res = await app.handle(buildRequest(TID.run(), { approved: true }));
    expect(res.status).toBe(409);
  });

  test("resume with approved=true returns 200 and calls session.resume", async () => {
    const sm = fakeSessionManager();
    const sid = TID.session();
    const rid = TID.run();
    sm.open(sid, { model: { id: "mock", stream: async function* () {} } as never }); // pre-create so get finds it

    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await app.handle(buildRequest(rid, { approved: true, message: "approved" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resumed).toBe(true);
    expect(sm.resumeCalls).toHaveLength(1);
    expect(sm.resumeCalls[0]!.approved).toBe(true);
    expect(sm.resumeCalls[0]!.message).toBe("approved");
  });

  test("resume with approved=false returns 200", async () => {
    const sm = fakeSessionManager();
    const sid = TID.session();
    const rid = TID.run();
    sm.open(sid, { model: { id: "mock", stream: async function* () {} } as never });

    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await app.handle(buildRequest(rid, { approved: false }));
    expect(res.status).toBe(200);
    expect(sm.resumeCalls).toHaveLength(1);
    expect(sm.resumeCalls[0]!.approved).toBe(false);
  });

  test("second resume on same session is repeatable", async () => {
    const sm = fakeSessionManager();
    const sid = TID.session();
    const rid = TID.run();
    sm.open(sid, { model: { id: "mock", stream: async function* () {} } as never });

    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    // First resume
    await app.handle(buildRequest(rid, { approved: true }));
    // Second resume
    await app.handle(buildRequest(rid, { approved: false }));

    expect(sm.resumeCalls).toHaveLength(2);
  });

  test("returns 422 on invalid body", async () => {
    const sm = fakeSessionManager();
    const app = makeApp({
      sessionManager: sm,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await app.handle(buildRequest(TID.run(), { approved: "not-a-boolean" }));
    expect(res.status).toBe(422); // Elysia TypeBox validation default
  });
});
