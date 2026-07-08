import { Elysia, t } from "elysia";
import type { SettingsService } from "./service.js";

export function settingsRoutes(svc: SettingsService) {
  return new Elysia()
    .get("/api/settings", () => ({ settings: svc.getAll() }))
    .get("/api/settings/system", () => svc.getSystemInfo())
    .put(
      "/api/settings/:key",
      ({ params: { key }, body }) => {
        svc.set(key, body.value);
        return { ok: true, key, value: body.value };
      },
      {
        body: t.Object({ value: t.Unknown() }),
      },
    );
}
