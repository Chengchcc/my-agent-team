import { parseEnv } from "@my-agent-team/config";
import { clearCookieHeader, createSession, readSession, sessionCookieHeader } from "./session";

const _env = parseEnv(process.env);
const MOCK_USER_ID = _env.MOCK_USER_ID ?? "user-001";
const MOCK_PASSWORD = _env.MOCK_PASSWORD ?? "admin";

export async function login(password: string): Promise<{ cookie: string } | { error: string }> {
  if (password !== MOCK_PASSWORD) return { error: "Invalid password" };
  const session = await createSession(MOCK_USER_ID);
  return { cookie: sessionCookieHeader(session) };
}

export async function getSession(cookieHeader: string | null) {
  return readSession(cookieHeader);
}

export function logout() {
  return clearCookieHeader();
}
