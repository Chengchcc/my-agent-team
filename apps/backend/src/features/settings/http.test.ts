import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

describe("settings routes", () => {
  test("get-all and system info answer", async () => {
    const all = await api(harness, "GET", "/api/settings");
    expect(all.status).toBe(200);
    expect(((await all.json()) as { settings: unknown }).settings).toBeDefined();

    const info = await api(harness, "GET", "/api/settings/system");
    expect(info.status).toBe(200);
  });

  test("plain keys round-trip; secret-shaped keys are refused", async () => {
    const put = await api(harness, "PUT", "/api/settings/theme", { value: "dark" });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, key: "theme", value: "dark" });

    const secret = await api(harness, "PUT", "/api/settings/larkAppSecret", { value: "x" });
    expect(secret.status).toBe(400);
    expect(((await secret.json()) as { error: string }).error).toContain("not writable");
  });
});
