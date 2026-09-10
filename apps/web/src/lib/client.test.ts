import { describe, expect, test } from "bun:test";
import { unwrap } from "./client";

function treatyLike(data: unknown, error: unknown, status: number) {
  return Promise.resolve({ data, error, status } as {
    data: unknown;
    error: unknown;
    status: number;
  });
}

describe("unwrap", () => {
  test("returns the plain body for direct backend (SSR) responses", async () => {
    const row = { agentId: "a1", name: "A" };
    expect(await unwrap(treatyLike(row, null, 200))).toEqual(row);
  });

  test("extracts JSON from BFF-proxied Response bodies", async () => {
    const wrapped = new Response(JSON.stringify({ ok: true }));
    expect(await unwrap(treatyLike(wrapped, null, 200))).toEqual({ ok: true });
  });

  test("204 yields undefined despite an empty body", async () => {
    expect(await unwrap(treatyLike("", null, 204))).toBeUndefined();
  });

  test("string errors become ApiError with the upstream status", async () => {
    expect(unwrap(treatyLike(null, "Run not found", 404))).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Run not found",
    });
  });

  test("object errors are JSON-stringified into the message", async () => {
    const err = await unwrap(treatyLike(null, { error: "bad" }, 422)).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ApiError", status: 422, message: '{"error":"bad"}' });
  });

  test("null data is an empty-response ApiError", async () => {
    const err = await unwrap(treatyLike(null, null, 200)).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 200, message: "Empty response" });
  });

  test("401 outside a browser surfaces the upstream error (no redirect possible)", async () => {
    const err = await unwrap(treatyLike(null, "Unauthorized", 401)).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, message: "Unauthorized" });
  });

  test("401 in a browser redirects to /login and throws Session expired", async () => {
    const previous = globalThis.window;
    const location = { href: "" };
    (globalThis as { window: unknown }).window = { location };
    try {
      const err = await unwrap(treatyLike(null, "Unauthorized", 401)).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 401, message: "Session expired" });
      expect(location.href).toBe("/login");
    } finally {
      (globalThis as { window: unknown }).window = previous;
    }
  });
});
