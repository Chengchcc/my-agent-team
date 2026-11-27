import { describe, expect, test } from "bun:test";
import { productToolsRoutes } from "./http.js";
import type { ProductToolsService } from "./service.js";

describe("product-tools HTTP routes", () => {
  test("POST /api/product-tools/ask/resolve returns 200 on pending ask, 409 when already resolved, 422 on bad body", async () => {
    const resolved: Array<{ runId: string; callId: string }> = [];
    const fakeSvc = {
      async resolveAskDurable(runId: string, callId: string) {
        if (runId === "run-live" && callId === "call-1") {
          resolved.push({ runId, callId });
          return true;
        }
        return false;
      },
    } as unknown as ProductToolsService;

    const app = productToolsRoutes(fakeSvc);

    // Valid pending ask -> 200
    const ok = await app.handle(
      new Request("http://localhost/api/product-tools/ask/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-live",
          callId: "call-1",
          answer: { answers: [{ id: "q1", selectedValues: ["yes"], freeText: "" }] },
        }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(resolved).toEqual([{ runId: "run-live", callId: "call-1" }]);

    // Missing / already resolved ask -> 409
    const conflict = await app.handle(
      new Request("http://localhost/api/product-tools/ask/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-stale",
          callId: "call-gone",
          answer: { answers: [] },
        }),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { ok: boolean }).ok).toBe(false);

    // Invalid body (empty runId) -> 422
    const invalid = await app.handle(
      new Request("http://localhost/api/product-tools/ask/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "", callId: "c1", answer: { answers: [] } }),
      }),
    );
    expect(invalid.status).toBe(422);
  });
});
