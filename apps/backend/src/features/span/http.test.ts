/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  fakeGetSessionIdByRunId,
  fakeSessionFactory,
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
  sessionFactory: ReturnType<typeof fakeSessionFactory>;
  getSessionIdByRunId: (spanId: string) => string | null;
}) {
  return new Elysia().use(resumeRoutes(deps as any));
}

describe("resumeRoute", () => {
  test("returns 404 when spanId not found", async () => {
    const sf = fakeSessionFactory();
    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await app.handle(buildRequest(TID.run(), { approved: true }));
    expect(res.status).toBe(404);
  });

  test("returns 409 when session no longer active", async () => {
    const sf = fakeSessionFactory();
    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [TID.run()]: TID.session() }),
    });
    // session not created → peek returns undefined → 409
    const res = await app.handle(buildRequest(TID.run(), { approved: true }));
    expect(res.status).toBe(409);
  });

  test("resume with approved=true returns 200 and calls session.resume", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {}); // pre-create so peek finds it

    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await app.handle(buildRequest(rid, { approved: true, message: "approved" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.spanId).toBe(rid);

    expect(sf.resumeCalls).toHaveLength(1);
    expect(sf.resumeCalls[0]!.approved).toBe(true);
    expect(sf.resumeCalls[0]!.message).toBe("approved");
  });

  test("resume with approved=false returns 200", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {});

    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await app.handle(buildRequest(rid, { approved: false }));
    expect(res.status).toBe(200);

    expect(sf.resumeCalls).toHaveLength(1);
    expect(sf.resumeCalls[0]!.approved).toBe(false);
  });

  test("second resume on same session is repeatable", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {});

    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    // First resume
    let res = await app.handle(buildRequest(rid, { approved: true }));
    expect(res.status).toBe(200);

    // Second resume — should still work (session persists across spans)
    res = await app.handle(buildRequest(rid, { approved: false }));
    expect(res.status).toBe(200);

    expect(sf.resumeCalls).toHaveLength(2);
  });

  test("returns 422 on invalid body", async () => {
    const sf = fakeSessionFactory();
    const app = makeApp({
      sessionFactory: sf,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await app.handle(buildRequest(TID.run(), { approved: "not-a-boolean" }));
    expect(res.status).toBe(422); // Elysia TypeBox validation default
  });
});
