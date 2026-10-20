import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSecret, encryptSecret, isEncrypted, loadOrCreateMcpKey } from "./mcp-secrets.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-secrets-"));
afterAll(() => {});

describe("mcp secrets at rest", () => {
  test("the key is created once, 0600, and other launcher fields survive", () => {
    const path = join(dir, "gateway-secrets.json");
    // Pretend the launcher already wrote the login password hash.
    writeFileSync(path, JSON.stringify({ passwordHash: "keep-me" }));
    chmodSync(path, 0o644);

    const first = loadOrCreateMcpKey(path);
    expect(first.length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.passwordHash).toBe("keep-me");

    // Stable across loads: a new process must decrypt yesterday's secrets.
    const second = loadOrCreateMcpKey(path);
    expect(second.equals(first)).toBe(true);
  });

  test("roundtrip keeps the value, the ciphertext does not contain it", () => {
    const key = loadOrCreateMcpKey(join(dir, "k1.json"));
    const encrypted = encryptSecret("Bearer super-secret", key);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain("super-secret");
    expect(decryptSecret(encrypted, key)).toBe("Bearer super-secret");
  });

  test("legacy plaintext passes through (the adapter re-encrypts it)", () => {
    const key = loadOrCreateMcpKey(join(dir, "k2.json"));
    expect(decryptSecret("plain-token", key)).toBe("plain-token");
  });

  test("a wrong key fails loudly instead of handing back garbage", () => {
    const keyA = loadOrCreateMcpKey(join(dir, "kA.json"));
    const keyB = loadOrCreateMcpKey(join(dir, "kB.json"));
    const encrypted = encryptSecret("token", keyA);
    expect(() => decryptSecret(encrypted, keyB)).toThrow(/cannot be decrypted/);
  });
});
