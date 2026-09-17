import { afterAll, describe, expect, test } from "bun:test";

/** Stands in for the backend's `/api/auth/verify`: `source` mirrors whether a
 *  console-set password exists, and a password is "right" when it matches. */
const backendState = { source: "stored" as "stored" | "none" };
let stopped = false;
const RIGHT = "right-password";
const backend = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path !== "/api/auth/verify") return new Response("not found", { status: 404 });
    const body: unknown = await req.json();
    const password =
      typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
    return Response.json({
      source: backendState.source,
      verified: password === RIGHT,
    });
  },
});

// parseEnv() memoizes on its first call, so the environment has to be in place
// before auth.js is imported — the module-scope trap this repo has hit before.
const saved = { ...process.env };
process.env.BACKEND_URL = `http://127.0.0.1:${backend.port}`;
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-session-secret";
process.env.MOCK_PASSWORD = "env-password";
const { login } = await import("./auth.js");

afterAll(() => {
  if (!stopped) backend.stop(true);
  for (const key of ["BACKEND_URL", "BACKEND_AUTH_TOKEN", "SESSION_SECRET", "MOCK_PASSWORD"]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("login", () => {
  test("a password set in the console wins over the environment one", async () => {
    backendState.source = "stored";
    expect(await login(RIGHT)).toHaveProperty("cookie");
    expect(await login("env-password")).toEqual({ error: "Invalid password" });
  });

  test("falls back to the environment password when none is stored", async () => {
    backendState.source = "none";
    expect(await login("env-password")).toHaveProperty("cookie");
    expect(await login(RIGHT)).toEqual({ error: "Invalid password" });
  });

  // Last on purpose: it takes the stub down. parseEnv() is memoized, so
  // rewriting BACKEND_URL here would not reach the already-parsed config —
  // stopping the server is what actually makes the backend unreachable.
  test("falls back too when the backend cannot answer", async () => {
    backendState.source = "stored";
    stopped = true;
    backend.stop(true);
    // A dead backend must not lock the operator out of their own console.
    expect(await login("env-password")).toHaveProperty("cookie");
  });
});
