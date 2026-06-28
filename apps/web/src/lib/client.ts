import { treaty } from "@elysiajs/eden";
import type { App } from "@my-agent-team/backend/app";

/** Client-side treaty — through BFF (cookie → x-auth-token translation). */
export const client = treaty<App>("/api/bff", {
  fetch: { credentials: "include" },
});

/** Server-side treaty — direct to backend with x-auth-token (SSR bootstrap). */
export function createServerClient(backendUrl: string, authToken: string) {
  return treaty<App>(backendUrl, {
    headers: { "x-auth-token": authToken },
  });
}

/**
 * Unwrap treaty response into typed JSON body.
 *
 * Treaty returns { data, error, status } where data is Response (since handlers
 * return opaque Response objects). We extract the JSON body from data.
 * Once Elysia handlers return typed objects, data will be directly typed.
 */
export async function unwrap<T>(
  p: Promise<{ data: unknown; error: unknown; status: number }>,
): Promise<T> {
  const { data: res, error, status } = await p;
  if (status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (error) {
    throw new ApiError(status, typeof error === "string" ? error : JSON.stringify(error));
  }
  if (!res) throw new ApiError(status, "Empty response");
  if (status === 204) return undefined as T;
  return (res as Response).json() as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
