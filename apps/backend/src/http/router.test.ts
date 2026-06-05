import { describe, expect, test } from "bun:test";
import { createRouter } from "./router.js";

function makeRouter() {
  return createRouter("test-token");
}

describe("Router", () => {
  test("GET /health returns 200 without auth", async () => {
    const router = makeRouter();
    const req = new Request("http://localhost/health");
    const resp = await router(req);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("unauthenticated request returns 401", async () => {
    const router = makeRouter();
    const req = new Request("http://localhost/api/agents");
    const resp = await router(req);
    expect(resp.status).toBe(401);
  });

  test("authenticated request passes through", async () => {
    const router = makeRouter();
    const req = new Request("http://localhost/api/agents", {
      headers: { "x-auth-token": "test-token" },
    });
    const resp = await router(req);
    expect(resp.status).toBe(200);
  });

  test("unknown route returns 404", async () => {
    const router = makeRouter();
    const req = new Request("http://localhost/unknown", {
      headers: { "x-auth-token": "test-token" },
    });
    const resp = await router(req);
    expect(resp.status).toBe(404);
  });
});
