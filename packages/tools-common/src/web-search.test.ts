import { describe, expect, mock, test } from "bun:test";
import { createWebSearchTool } from "./web-search.js";

describe("createWebSearchTool", () => {
  test("calls Tavily API and returns serialized results", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body as string);
      expect(body.api_key).toBe("tvly-test-key");
      expect(body.query).toBe("weather");
      return Promise.resolve(
        new Response(JSON.stringify({ results: [{ title: "Weather", url: "https://w.com" }] })),
      );
    }) as unknown as typeof fetch;
    const tool = createWebSearchTool("tvly-test-key");
    const result = await tool.execute({ query: "weather" });

    expect(result.content).toBe(JSON.stringify([{ title: "Weather", url: "https://w.com" }]));
  });

  test("returns raw data when results field absent", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ answer: "42" }))),
    ) as unknown as typeof fetch;
    const tool = createWebSearchTool("key");
    const result = await tool.execute({ query: "life" });

    expect(result.content).toBe(JSON.stringify({ answer: "42" }));
  });

  test("returns empty results array as JSON string", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }))),
    ) as unknown as typeof fetch;

    const tool = createWebSearchTool("key");
    const result = await tool.execute({ query: "nothing" });

    expect(result.content).toBe(JSON.stringify([]));
  });
});
