import { describe, expect, mock, test } from "bun:test";
import { webFetchTool } from "./web-fetch.js";

describe("webFetchTool", () => {
  test("returns fetched text content", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("hello world", { status: 200 })),
    );

    const result = await webFetchTool.execute({ url: "https://example.com" });

    expect(result).toEqual({ content: "hello world" });
  });

  test("truncates content over 20000 characters", async () => {
    const longText = "x".repeat(25000);
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(longText, { status: 200 })),
    );

    const result = await webFetchTool.execute({ url: "https://example.com" });

    expect(result.content).toStartWith("x".repeat(20000));
    expect(result.content).toInclude("truncated, original length: 25000");
  });
});
