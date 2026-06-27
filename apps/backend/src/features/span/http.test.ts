/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "bun:test";
import {
  fakeGetSessionIdByRunId,
  fakeSessionFactory,
  TID,
} from "../../../test-helpers/mock-deps.js";
import { resumeRoute } from "./http.js";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/runs/r1/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("resumeRoute", () => {
  test("returns 404 when spanId not found", async () => {
    const sf = fakeSessionFactory();
    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await handler(buildRequest({ approved: true }), TID.run());
    expect(res.status).toBe(404);
  });

  test("returns 409 when session no longer active", async () => {
    const sf = fakeSessionFactory();
    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [TID.run()]: TID.session() }),
    });
    // session not created → peek returns undefined → 409
    const res = await handler(buildRequest({ approved: true }), TID.run());
    expect(res.status).toBe(409);
  });

  test("resume with approved=true returns 202 and calls session.resume", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {}); // pre-create so peek finds it

    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await handler(buildRequest({ approved: true, message: "approved" }), rid);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.spanId).toBe(rid);

    expect(sf.resumeCalls).toHaveLength(1);
    expect(sf.resumeCalls[0]!.approved).toBe(true);
    expect(sf.resumeCalls[0]!.message).toBe("approved");
  });

  test("resume with approved=false returns 202", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {});

    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    const res = await handler(buildRequest({ approved: false }), rid);
    expect(res.status).toBe(202);

    expect(sf.resumeCalls).toHaveLength(1);
    expect(sf.resumeCalls[0]!.approved).toBe(false);
  });

  test("second resume on same session is repeatable", async () => {
    const sf = fakeSessionFactory();
    const sid = TID.session();
    const rid = TID.run();
    sf.getOrCreate(sid, {});

    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({ [rid]: sid }),
    });

    // First resume
    let res = await handler(buildRequest({ approved: true }), rid);
    expect(res.status).toBe(202);

    // Second resume — should still work (session persists across spans)
    res = await handler(buildRequest({ approved: false }), rid);
    expect(res.status).toBe(202);

    expect(sf.resumeCalls).toHaveLength(2);
  });

  test("returns 400 on invalid body", async () => {
    const sf = fakeSessionFactory();
    const handler = resumeRoute({
      sessionFactory: sf as any,
      getSessionIdByRunId: fakeGetSessionIdByRunId({}),
    });

    const res = await handler(buildRequest({ approved: "not-a-boolean" }), TID.run());
    expect(res.status).toBe(400);
  });
});
