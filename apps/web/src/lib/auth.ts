import { createSession, readSession, sessionCookieHeader, clearCookieHeader } from "./session";

const MOCK_USER_ID = process.env.MOCK_USER_ID ?? "user-001";
const MOCK_PASSWORD = process.env.MOCK_PASSWORD ?? "admin";

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
