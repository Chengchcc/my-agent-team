import { Elysia, t } from "elysia";
import { createTokenBucketLimiter, type TokenBucketLimiter } from "../../infra/rate-limit.js";
import type { PasswordService } from "./password.js";

/** Login-password plumbing for the web console, behind the service token like
 *  the rest of the admin surface: the BFF asks `verify` on every login and the
 *  settings page sets a new one. `source: "none"` means no UI-set password
 *  exists yet, so the caller should keep using its configured one. */
export function authRoutes(svc: PasswordService, opts?: { verifyLimiter?: TokenBucketLimiter }) {
  const verifyLimiter =
    opts?.verifyLimiter ?? createTokenBucketLimiter({ capacity: 10, refillPerSec: 10 / 60 });

  return new Elysia()
    .post(
      "/api/auth/verify",
      async ({ body, headers, set }) => {
        const forwarded = headers["x-forwarded-for"]?.split(",")[0]?.trim();
        const key = forwarded || headers["x-real-ip"] || "local";
        const decision = verifyLimiter.consume(key);
        if (!decision.allowed) {
          set.status = 429;
          set.headers["retry-after"] = String(decision.retryAfterSec);
          return { error: "Too many authentication attempts; try again later" };
        }
        const result = await svc.verify(body.password);
        if (result === undefined) return { source: "none" as const, verified: false };
        if (result) verifyLimiter.reset(key);
        return { source: "stored" as const, verified: result };
      },
      { body: t.Object({ password: t.String() }) },
    )
    .get("/api/auth/password", () => ({ configured: svc.isSet() }))
    .put(
      "/api/auth/password",
      async ({ body }) => {
        await svc.set(body.password);
        return { ok: true };
      },
      { body: t.Object({ password: t.String({ minLength: 8 }) }) },
    );
}
