import { beforeEach, describe, expect, test } from "bun:test";

// Fixed test secret + secure-cookie opt-in, set before the module's lazy
// env() cache initializes. *.test.ts files are exempt from audit:contracts.
process.env.SESSION_SECRET = "test-hmac-secret";
process.env.SESSION_COOKIE_SECURE = "1";
process.env.BACKEND_AUTH_TOKEN = "be-secret";

const {
  clearCookieHeader,
  createSession,
  readSession,
  resetEnvCacheForTests,
  sessionCookieHeader,
} = await import("./session");

const COOKIE = "maw_session";

/** Same cookie format as createSession, with a caller-chosen payload — lets
 *  tests pin expiry/shape handling without waiting 7 days. */
async function craftCookie(payload: object, secret = "test-hmac-secret"): Promise<string> {
  const enc = new TextEncoder();
  const json = JSON.stringify(payload);
  const b64url = (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(json));
  return `${b64url(enc.encode(json).buffer)}.${b64url(sig)}`;
}

function cookieHeader(value: string): string {
  return `${COOKIE}=${value}`;
}

describe("session round-trip", () => {
  beforeEach(() => {
    delete process.env.SESSION_COOKIE_SECURE;
    process.env.SESSION_COOKIE_SECURE = "1";
    // Earlier test files (alphabetical load) may have frozen the module's
    // env cache without the secure opt-in; re-parse per test.
    resetEnvCacheForTests();
  });

  test("createSession → readSession returns the same userId", async () => {
    const value = await createSession("u7");
    const payload = await readSession(cookieHeader(value));
    expect(payload).toMatchObject({ userId: "u7" });
    // Expiry is set ~7 days out.
    expect(payload!.exp).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  test("the session cookie survives among other cookies", async () => {
    const value = await createSession("u8");
    const payload = await readSession(`other=a; ${COOKIE}=${value}; tz=utc`);
    expect(payload!.userId).toBe("u8");
  });
});

describe("readSession rejections (all → null, never a throw)", () => {
  test("missing cookie header / missing session cookie", async () => {
    expect(await readSession(null)).toBeNull();
    expect(await readSession("other=1")).toBeNull();
    expect(await readSession("")).toBeNull();
  });

  test("malformed value: no signature part, undecodable payload", async () => {
    expect(await readSession(cookieHeader("not-a-signed-cookie"))).toBeNull();
    expect(await readSession(cookieHeader("%%%bad%%%.$_$.sig"))).toBeNull();
  });

  test("tampered payload fails the HMAC check", async () => {
    const value = await createSession("u1");
    const [payload, sig] = value.split(".");
    // Flip the userId inside the payload, keep the original signature.
    const decoded = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
    decoded.userId = "attacker";
    const forged = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await readSession(cookieHeader(`${forged}.${sig}`))).toBeNull();
  });

  test("expired session is rejected", async () => {
    const expired = await craftCookie({ userId: "u2", exp: Date.now() - 1000 });
    expect(await readSession(cookieHeader(expired))).toBeNull();
  });

  test("payload without a numeric exp is rejected", async () => {
    const weird = await craftCookie({ userId: "u3", exp: "soon" });
    expect(await readSession(cookieHeader(weird))).toBeNull();
  });
});

describe("cookie headers", () => {
  beforeEach(() => {
    process.env.SESSION_COOKIE_SECURE = "1";
    resetEnvCacheForTests();
  });

  test("session cookie carries HttpOnly, SameSite=Lax, Path=/, Secure opt-in", () => {
    const header = sessionCookieHeader("v");
    expect(header).toContain(`${COOKIE}=v`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure"); // SESSION_COOKIE_SECURE=1
    expect(header).toContain("Max-Age=604800");
  });

  test("clear cookie forces Max-Age=0", () => {
    const header = clearCookieHeader();
    expect(header).toContain(`${COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  test("custom max-age overrides the default", () => {
    expect(sessionCookieHeader("v", 60)).toContain("Max-Age=60");
  });
});
