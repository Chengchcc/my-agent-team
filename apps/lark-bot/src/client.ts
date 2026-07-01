import type { Treaty } from "@elysiajs/eden";
import { treaty } from "@elysiajs/eden";
import type { App } from "@my-agent-team/backend/app";

type AppClient = Treaty.Create<App>;

export function createClient(backendUrl: string, token: string | null): AppClient {
  const headers: Record<string, string> = {};
  if (token) headers["x-auth-token"] = token;
  return treaty<App>(backendUrl, { headers });
}
