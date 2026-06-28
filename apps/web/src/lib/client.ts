import { treaty } from "@elysiajs/eden";
import type { App } from "@my-agent-team/backend/app";

/** Treaty client — single source for all API calls. Types derived from backend App. */
export const client = treaty<App>("/api/bff", {
  fetch: { credentials: "include" },
});

/** Unwrap treaty response: throw ApiError on failure, handle 401 redirect. */
export async function unwrap<T>(
  p: Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<T> {
  const { data, error, status } = await p;
  if (status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (error) {
    throw new ApiError(status, typeof error === "string" ? error : JSON.stringify(error));
  }
  if (status === 204) return undefined as T;
  if (data === null || data === undefined) {
    throw new ApiError(status, "Empty response");
  }
  return data;
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
