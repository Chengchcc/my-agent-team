import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

describe("proposal routes", () => {
  test("a target with nothing proposed answers with null", async () => {
    const res = await api(harness, "GET", "/api/proposals/agent_config/agent-nobody");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposal: null });
  });

  test("an unknown kind is refused rather than guessed at", async () => {
    const res = await api(harness, "GET", "/api/proposals/something_else/agent-1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown proposal kind");
  });

  test("only adopted or discarded are decisions; anything else is a bad request", async () => {
    const res = await api(harness, "POST", "/api/proposals/p-nope/maybe");
    expect(res.status).toBe(400);
  });

  test("deciding a proposal that is not pending is a conflict", async () => {
    const res = await api(harness, "POST", "/api/proposals/p-nope/adopted");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no longer pending");
  });
});
