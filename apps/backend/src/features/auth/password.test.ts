import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../infra/domain-errors.js";
import type { SettingsService } from "../settings/index.js";
import { createPasswordService } from "./password.js";

/** Minimal in-memory KV: the password service only needs get/set. */
function fakeSettings(): SettingsService {
  const rows: Record<string, unknown> = {};
  return {
    get<T>(key: string): T | undefined {
      return rows[key] as T | undefined;
    },
    set<T>(key: string, value: T): void {
      rows[key] = value;
    },
    getAll: () => rows,
    getSystemInfo: () => ({
      env: {},
      paths: {
        dataDir: "/tmp",
        workspaceRoot: "/tmp",
        agentWorkspace: "/tmp",
        skillPacks: "/tmp",
        backendDb: "/tmp/db",
        builtinSkills: "/tmp/skills",
      },
    }),
  };
}

describe("password service", () => {
  test("stores a verifier, never the plaintext", async () => {
    const settings = fakeSettings();
    const svc = createPasswordService(settings);
    await svc.set("correct horse battery");
    const stored = settings.get<string>("auth.password_hash");
    expect(stored).toBeString();
    expect(stored).not.toContain("correct horse");
    expect(stored?.startsWith("$argon2id$")).toBeTrue();
  });

  test("verifies the right password and rejects the wrong one", async () => {
    const svc = createPasswordService(fakeSettings());
    await svc.set("hunter2-hunter2");
    expect(await svc.verify("hunter2-hunter2")).toBeTrue();
    expect(await svc.verify("hunter2-hunter3")).toBeFalse();
  });

  test("reports no stored password so callers can fall back", async () => {
    const svc = createPasswordService(fakeSettings());
    expect(await svc.verify("anything")).toBeUndefined();
    expect(svc.isSet()).toBeFalse();
  });

  test("refuses a password shorter than the floor", async () => {
    const svc = createPasswordService(fakeSettings());
    await expect(svc.set("short")).rejects.toThrow(ValidationError);
  });
});
