import { describe, expect, test } from "bun:test";
import { checkAuth, checkAuthToken } from "./auth.js";

describe("checkAuthToken", () => {
  test("equal strings match", () => {
    expect(checkAuthToken("secret-token", "secret-token")).toBe(true);
  });

  test("length mismatch rejects before comparing (fail-closed)", () => {
    expect(checkAuthToken("short", "secret-token")).toBe(false);
    expect(checkAuthToken("a-much-longer-header-value", "secret-token")).toBe(false);
  });

  test("same length, different content rejects", () => {
    expect(checkAuthToken("secrer-token", "secret-token")).toBe(false);
  });

  test("missing header is not a match", () => {
    expect(checkAuthToken("", "secret-token")).toBe(false);
  });
});

describe("checkAuth", () => {
  test("reads the x-auth-token header", () => {
    const req = new Request("http://localhost/api/agents", {
      headers: { "x-auth-token": "secret-token" },
    });
    expect(checkAuth(req, "secret-token")).toBe(true);
    expect(checkAuth(new Request("http://localhost/api/agents"), "secret-token")).toBe(false);
  });
});
