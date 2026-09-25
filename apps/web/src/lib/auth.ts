import { createHash, timingSafeEqual } from "node:crypto";
import { parseEnv } from "@chengchenccc/config";
import { createServerClient } from "./client";
import { clearCookieHeader, createSession, readSession, sessionCookieHeader } from "./session";

let _env: ReturnType<typeof parseEnv> | undefined;
function env() {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

function mockUserId() {
  return env().MOCK_USER_ID ?? "user-001";
}

/** Bootstrap password, used ONLY before this stack has a stored one.
 *
 *  The backend adopts MOCK_PASSWORD as an argon2id hash on its first boot
 *  (`PasswordService.seedFromBootstrap`), after which the database is the single
 *  source of truth and this env value is irrelevant — it is regenerated per
 *  checkout, so treating it as a live fallback made the login password appear to
 *  reset whenever `.env` was recreated.
 *
 *  F3: no default password. Unconfigured MOCK_PASSWORD fails closed — login
 *  is locked, with a one-time random escape hatch printed for a local
 *  operator (the console is the only place it ever appears). */
let _ephemeralPassword: string | null = null;
function mockPassword(): string {
  const configured = env().MOCK_PASSWORD;
  if (configured) return configured;
  _ephemeralPassword ??= crypto.randomUUID();
  console.warn(
    `[auth] MOCK_PASSWORD is not configured; login is locked. One-time local ` +
      `escape password: ${_ephemeralPassword}`,
  );
  return _ephemeralPassword;
}

/** Constant-time comparison: hash both sides to fixed length first, then
 *  timingSafeEqual. Prevents length/prefix timing side channels. */
export function timingSafeEqualPassword(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Whether the stack's stored password matches. `undefined` means the stack has
 *  no stored password yet (first boot before the seed) or the backend cannot
 *  answer — an unreachable backend must not lock the operator out of their own
 *  console. */
async function storedPasswordMatches(password: string): Promise<boolean | undefined> {
  try {
    const config = env();
    const res = await createServerClient(
      config.BACKEND_URL,
      config.BACKEND_AUTH_TOKEN,
    ).api.auth.verify.post({ password });
    if (res.error || !res.data) return undefined;
    return res.data.source === "stored" ? res.data.verified : undefined;
  } catch {
    return undefined;
  }
}

import { INVALID_PASSWORD } from "@/lib/auth-codes";

export { INVALID_PASSWORD };

export async function login(password: string): Promise<{ cookie: string } | { error: string }> {
  const fromStore = await storedPasswordMatches(password);
  const accepted =
    fromStore === undefined ? timingSafeEqualPassword(password, mockPassword()) : fromStore;
  if (!accepted) return { error: INVALID_PASSWORD };
  const session = await createSession(mockUserId());
  return { cookie: sessionCookieHeader(session) };
}

export async function getSession(cookieHeader: string | null) {
  return readSession(cookieHeader);
}

export function logout() {
  return clearCookieHeader();
}
