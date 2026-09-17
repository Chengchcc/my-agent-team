import { Elysia, t } from "elysia";
import type { PasswordService } from "./password.js";

/** Login-password plumbing for the web console, behind the service token like
 *  the rest of the admin surface: the BFF asks `verify` on every login and the
 *  settings page sets a new one. `source: "none"` means no UI-set password
 *  exists yet, so the caller should keep using its configured one. */
export function authRoutes(svc: PasswordService) {
  return new Elysia()
    .post(
      "/api/auth/verify",
      async ({ body }) => {
        const result = await svc.verify(body.password);
        if (result === undefined) return { source: "none" as const, verified: false };
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
