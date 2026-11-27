import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendConfig } from "../../config.js";
import { createTokenBucketLimiter } from "../../infra/rate-limit.js";
import { openDb } from "../../infra/sqlite/db.js";
import { createSettingsService, sqliteSettingsAdapter } from "../settings/index.js";
import { authRoutes } from "./http.js";
import { createPasswordService } from "./password.js";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "auth-http-test-"));
  db = openDb(join(dir, "backend.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth HTTP routes", () => {
  test("get/put/verify password lifecycle and rate limit", async () => {
    const settingsSvc = createSettingsService({
      port: sqliteSettingsAdapter(db),
      config: { dataDir: dir } as BackendConfig,
      secretKey: Buffer.alloc(32, 7),
    });
    const passwordSvc = createPasswordService(settingsSvc, { dataDir: dir });
    const app = authRoutes(passwordSvc, {
      verifyLimiter: createTokenBucketLimiter({ capacity: 3, refillPerSec: 0 }),
    });

    // Initially unconfigured
    const cfg0 = await app.handle(new Request("http://localhost/api/auth/password"));
    expect(cfg0.status).toBe(200);
    expect(await cfg0.json()).toEqual({ configured: false });

    const verifyUnset = await app.handle(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "1.2.3.4" },
        body: JSON.stringify({ password: "anything" }),
      }),
    );
    expect(verifyUnset.status).toBe(200);
    expect(await verifyUnset.json()).toEqual({ source: "none", verified: false });

    // Rejects short password (<8 chars)
    const tooShort = await app.handle(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "short" }),
      }),
    );
    expect(tooShort.status).toBe(422);

    // Sets a valid password
    const setRes = await app.handle(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse-battery" }),
      }),
    );
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toEqual({ ok: true });

    const cfg1 = await app.handle(new Request("http://localhost/api/auth/password"));
    expect(await cfg1.json()).toEqual({ configured: true });

    // Correct password verifies and resets bucket
    const okVerify = await app.handle(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "1.2.3.4" },
        body: JSON.stringify({ password: "correct-horse-battery" }),
      }),
    );
    expect(await okVerify.json()).toEqual({ source: "stored", verified: true });

    // 3 wrong attempts exhaust the limiter; 4th returns 429 with Retry-After
    for (let i = 0; i < 3; i++) {
      const bad = await app.handle(
        new Request("http://localhost/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
          body: JSON.stringify({ password: "wrong-password" }),
        }),
      );
      expect(bad.status).toBe(200);
      expect(await bad.json()).toEqual({ source: "stored", verified: false });
    }
    const blocked = await app.handle(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
        body: JSON.stringify({ password: "wrong-password" }),
      }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
});
