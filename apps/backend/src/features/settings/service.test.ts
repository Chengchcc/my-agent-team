import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendConfig } from "../../config.js";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSettingsAdapter } from "./adapter-sqlite.js";
import { createSettingsService } from "./service.js";

const db = openDb(":memory:");
const port = sqliteSettingsAdapter(db);

const mockConfig = {
  dataDir: "/test-data",
  workspaceRoot: "/test-data/workspaces",
  builtinSkillsDir: "/test-skills",
} as BackendConfig;

// Fixed key: the service must never reach for the deployment's real
// gateway-secrets.json while a test runs.
const TEST_KEY = Buffer.alloc(32, 7);
const svc = createSettingsService({ port, config: mockConfig, secretKey: TEST_KEY });

describe("SettingsService", () => {
  test("get missing key returns undefined", () => {
    expect(svc.get("does.not.exist")).toBeUndefined();
  });

  test("set + get number", () => {
    svc.set("num.key", 42);
    expect(svc.get<number>("num.key")).toBe(42);
  });

  test("set + get string", () => {
    svc.set("str.key", "hello");
    expect(svc.get<string>("str.key")).toBe("hello");
  });

  test("set + get boolean", () => {
    svc.set("bool.key", true);
    expect(svc.get<boolean>("bool.key")).toBe(true);
  });

  test("set + get object", () => {
    svc.set("obj.key", { nested: true });
    expect(svc.get<{ nested: boolean }>("obj.key")).toEqual({ nested: true });
  });

  test("overwrite existing key", () => {
    svc.set("ow.key", "A");
    expect(svc.get<string>("ow.key")).toBe("A");
    svc.set("ow.key", "B");
    expect(svc.get<string>("ow.key")).toBe("B");
  });

  test("getAll returns all keys", () => {
    svc.set("all.one", 1);
    svc.set("all.two", 2);
    svc.set("all.three", 3);
    const all = svc.getAll();
    expect(all["all.one"]).toBe(1);
    expect(all["all.two"]).toBe(2);
    expect(all["all.three"]).toBe(3);
  });

  test("getAll masks secret-shaped values (H5)", () => {
    svc.set("provider.anthropic", { apiKey: "sk-ant-secret-9z", baseUrl: "https://api.x" });
    svc.set("session.token", "tok-1234");
    const all = svc.getAll();
    const provider = all["provider.anthropic"] as { apiKey: string; baseUrl: string };
    expect(provider.apiKey).toMatch(/^\*{4}/);
    expect(provider.apiKey).not.toContain("sk-ant-secret-9z");
    expect(provider.baseUrl).toBe("https://api.x");
    expect(all["session.token"]).toMatch(/^\*{4}1234$/);
  });

  describe("getSystemInfo", () => {
    const KEY = "ANTHROPIC_API_KEY";
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[KEY];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    test("returns masked env + paths", () => {
      process.env[KEY] = "sk-ant-1234567890abcdef";
      const info = svc.getSystemInfo();
      expect(info.paths.dataDir).toBe("/test-data");
      expect(info.paths.workspaceRoot).toBe("/test-data/workspaces");
      expect(info.paths.builtinSkills).toBe("/test-skills");
      // secret env key is masked: **** + last4 of the value
      expect(info.env[KEY]).toBe("****cdef");
    });

    test("omits unset env keys", () => {
      delete process.env[KEY];
      const info = svc.getSystemInfo();
      expect(info.env[KEY]).toBeUndefined();
    });
  });

  test("secret-shaped values are sealed at rest and still readable", () => {
    svc.set("provider.openai", { apiKey: "sk-live-abc123", baseUrl: "https://api.openai.com" });
    const raw = port.get("provider.openai")?.value ?? "";
    // H5's other half: masking keeps it out of a response, sealing keeps it
    // out of a copied backend.db.
    expect(raw).toContain("enc:v1:");
    expect(raw).not.toContain("sk-live-abc123");
    const back = svc.get<{ apiKey: string; baseUrl: string }>("provider.openai");
    expect(back?.apiKey).toBe("sk-live-abc123");
    // Non-secret siblings stay readable as plain JSON.
    expect(back?.baseUrl).toBe("https://api.openai.com");
  });

  test("a secret that will not decrypt fails loudly instead of reading as absent", () => {
    svc.set("provider.rotated", { apiKey: "sk-rotates-321" });
    // A different key over the same row: pretending the provider is simply
    // unconfigured would send the next run out without credentials.
    const rotated = createSettingsService({
      port,
      config: mockConfig,
      secretKey: Buffer.alloc(32, 9),
    });
    expect(() => rotated.get("provider.rotated")).toThrow();
  });

  test("a legacy plaintext secret is re-sealed on its first read", () => {
    port.set("provider.legacy", JSON.stringify({ apiKey: "sk-legacy-777" }));
    expect(svc.get<{ apiKey: string }>("provider.legacy")?.apiKey).toBe("sk-legacy-777");
    const raw = port.get("provider.legacy")?.value ?? "";
    expect(raw).toContain("enc:v1:");
    expect(raw).not.toContain("sk-legacy-777");
  });
});
