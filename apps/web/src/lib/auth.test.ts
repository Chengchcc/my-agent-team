import { afterAll, describe, expect, test } from "bun:test";

// parseEnv requires BACKEND_AUTH_TOKEN; login's success path signs with
// SESSION_SECRET. CI has no .env, so the test must be self-contained.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

/** Stands in for the backend's `/api/auth/verify`. `source: "none"` keeps the
 *  environment password in play, which is what the F3 cases below exercise. */
const backendState = { source: "none" as "stored" | "none" };
const STORED_PASSWORD = "right-password";
const backend = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname !== "/api/auth/verify") {
      return new Response("not found", { status: 404 });
    }
    const body: unknown = await req.json();
    const password =
      typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
    return Response.json({ source: backendState.source, verified: password === STORED_PASSWORD });
  },
});
process.env.BACKEND_URL = `http://127.0.0.1:${backend.port}`;

afterAll(() => {
  backend.stop(true);
});

/** Fresh module instances per case so the module-level env cache does not
 *  leak between scenarios. Bun treats the query string as a distinct
 *  module URL. */
function freshAuth() {
  return import(`./auth.ts?case=${Math.random().toString(36).slice(2)}`);
}

describe("auth login (F3)", () => {
  test("without MOCK_PASSWORD the default admin password is rejected (fail-closed)", async () => {
    delete process.env.MOCK_PASSWORD;
    delete process.env.MOCK_USER_ID;
    const auth = await freshAuth();
    const result = await auth.login("admin");
    expect("error" in result).toBe(true);
    // The machine code, not a sentence: the login page matches on it, and the
    // prose it used to be made every JSON attempt fall through to the
    // generic message (the "wrong password shows no error" report).
    expect((result as { error: string }).error).toBe(auth.INVALID_PASSWORD);
  });

  test("a configured MOCK_PASSWORD signs in", async () => {
    process.env.MOCK_PASSWORD = "s3cret";
    const auth = await freshAuth();
    const result = await auth.login("s3cret");
    expect("cookie" in result).toBe(true);
    delete process.env.MOCK_PASSWORD;
  });

  test("timingSafeEqualPassword hashes before comparing", async () => {
    const auth = await freshAuth();
    expect(auth.timingSafeEqualPassword("same", "same")).toBe(true);
    expect(auth.timingSafeEqualPassword("same", "diff")).toBe(false);
    // Different lengths are safe (both sides hashed to 32 bytes first).
    expect(auth.timingSafeEqualPassword("a", "bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });
});

describe("the wrong-password wire code", () => {
  test("login reports the code the page matches, so the specific message is reachable", async () => {
    delete process.env.MOCK_PASSWORD;
    const auth = await freshAuth();
    const rejected = await auth.login("nope");
    expect(rejected).toEqual({ error: auth.INVALID_PASSWORD });
    expect(auth.INVALID_PASSWORD).toBe("invalid_password");
  });
});

describe("auth login (password set in the console)", () => {
  test("a console-set password wins over the environment one", async () => {
    backendState.source = "stored";
    process.env.MOCK_PASSWORD = "env-password";
    try {
      const auth = await freshAuth();
      expect("cookie" in (await auth.login(STORED_PASSWORD))).toBe(true);
      const rejected = await auth.login("env-password");
      expect("error" in rejected).toBe(true);
    } finally {
      backendState.source = "none";
      delete process.env.MOCK_PASSWORD;
    }
  });

  test("falls back to the environment password when none is stored", async () => {
    backendState.source = "none";
    process.env.MOCK_PASSWORD = "env-password";
    try {
      const auth = await freshAuth();
      expect("cookie" in (await auth.login("env-password"))).toBe(true);
      const rejected = await auth.login(STORED_PASSWORD);
      expect("error" in rejected).toBe(true);
    } finally {
      delete process.env.MOCK_PASSWORD;
    }
  });

  test("falls back too when the backend cannot answer", async () => {
    const reachable = process.env.BACKEND_URL;
    process.env.MOCK_PASSWORD = "env-password";
    // A dead backend must not lock the operator out of their own console. A
    // fresh module re-parses env, so re-pointing BACKEND_URL is enough here.
    process.env.BACKEND_URL = "http://127.0.0.1:9";
    try {
      const auth = await freshAuth();
      expect("cookie" in (await auth.login("env-password"))).toBe(true);
    } finally {
      process.env.BACKEND_URL = reachable;
      delete process.env.MOCK_PASSWORD;
    }
  });
});
