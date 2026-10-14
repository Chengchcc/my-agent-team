import { afterEach, describe, expect, test } from "bun:test";
import { subscribeDocEvents } from "./doc-subscription.js";
import type { TokenProvider } from "./lark-api.js";

const provider: TokenProvider = {
  getToken: async () => "tenant-token",
  invalidate: () => {},
  getBaseUrl: () => "https://open.feishu.cn",
};

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serve one canned response and record what the call looked like. */
function serve(status: number, body: string, seen: Seen[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("per-document event subscription", () => {
  test("file_type rides the query string, the event type the body", async () => {
    const seen: Seen[] = [];
    serve(200, '{"code":0,"data":{},"msg":"Success"}', seen);

    const result = await subscribeDocEvents(provider, "EWvsdouioonNMSxlY95m4uIly9w", "docx");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The measured failure: `file_type` in the body answers
    // "field validation failed: file_type is required".
    expect(seen[0]?.url).toBe(
      "https://open.feishu.cn/open-apis/drive/v1/files/EWvsdouioonNMSxlY95m4uIly9w/subscribe?file_type=docx",
    );
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.auth).toBe("Bearer tenant-token");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      event_type: "drive.notice.comment_add_v1",
    });
  });

  test("a rejected subscription reports the platform's own detail", async () => {
    const seen: Seen[] = [];
    serve(400, '{"code":99992402,"msg":"field validation failed"}', seen);

    const result = await subscribeDocEvents(provider, "token", "docx");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.detail).toContain("field validation failed");
  });

  test("a transport failure is a verdict, not a throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as typeof fetch;

    const result = await subscribeDocEvents(provider, "token", "docx");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.detail).toContain("socket closed");
  });
});
