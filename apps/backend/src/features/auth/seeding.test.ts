import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsService } from "../settings/index.js";
import { createPasswordService, PASSWORD_RESET_MARKER } from "./password.js";

/** Minimal KV: the password service only needs get/set. */
function kv(): { svc: SettingsService; map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    svc: {
      get: (k: string) => map.get(k),
      set: (k: string, v: unknown) => {
        map.set(k, v);
        return v;
      },
      delete: (k: string) => {
        map.delete(k);
      },
    } as unknown as SettingsService,
  };
}

describe("bootstrap password seeding", () => {
  test("adopts the launcher password once, then the DB is the only source", async () => {
    const { svc, map } = kv();
    const pw = createPasswordService(svc);

    expect(await pw.seedFromBootstrap("launcher-secret")).toBe("seeded");
    expect(map.get("auth.password_hash")).toStartWith("$argon2id$");
    expect(await pw.verify("launcher-secret")).toBe(true);

    // A later boot with a DIFFERENT env value (a regenerated .env, another
    // machine's gateway secret) must not touch the stored password — this is the
    // bug: the login password used to follow the env.
    expect(await pw.seedFromBootstrap("a-different-launcher-secret")).toBe("already-set");
    expect(await pw.verify("launcher-secret")).toBe(true);
    expect(await pw.verify("a-different-launcher-secret")).toBe(false);
  });

  test("reports none / too-short without writing anything", async () => {
    const { svc, map } = kv();
    const pw = createPasswordService(svc);
    expect(await pw.seedFromBootstrap(undefined)).toBe("none");
    expect(await pw.seedFromBootstrap("short")).toBe("too-short");
    expect(map.has("auth.password_hash")).toBe(false);
    // Nothing stored: callers still get the "no stored password" signal so the
    // launcher's password can be used for the pre-seed window.
    expect(await pw.verify("anything")).toBeUndefined();
  });

  test("the reset marker drops the stored password exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-reset-"));
    try {
      const { svc, map } = kv();
      const pw = createPasswordService(svc, { dataDir: dir });
      await pw.set("forgotten");
      writeFileSync(join(dir, PASSWORD_RESET_MARKER), "now\n");

      expect(await pw.seedFromBootstrap("new-password")).toBe("seeded");
      expect(await pw.verify("new-password")).toBe(true);
      expect(await pw.verify("forgotten")).toBe(false);
      // Consumed: the next boot must not drop the password again.
      expect(existsSync(join(dir, PASSWORD_RESET_MARKER))).toBe(false);
      expect(await pw.seedFromBootstrap("third-password")).toBe("already-set");
      expect(await pw.verify("new-password")).toBe(true);
      expect(map.get("auth.password_hash")).toStartWith("$argon2id$");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reset with no bootstrap value clears the hash and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-reset-"));
    try {
      const { svc, map } = kv();
      const pw = createPasswordService(svc, { dataDir: dir });
      await pw.set("forgotten");
      writeFileSync(join(dir, PASSWORD_RESET_MARKER), "now\n");
      expect(await pw.seedFromBootstrap(undefined)).toBe("reset");
      expect(map.has("auth.password_hash")).toBe(false);
      expect(await pw.verify("forgotten")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a console-set password is never overwritten by the bootstrap", async () => {
    const { svc } = kv();
    const pw = createPasswordService(svc);
    await pw.set("console-password");
    expect(await pw.seedFromBootstrap("launcher-secret")).toBe("already-set");
    expect(await pw.verify("console-password")).toBe(true);
  });
});
