import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { invalidateFactsCache } from "./cache.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryWriteTool } from "./memory-write.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("memory_search", () => {
  test("returns empty array when no match", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    const result = await memorySearchTool({ ws, root, searchLimit: 5 }).execute({
      query: "nothing",
    });
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual([]);
  });

  test("finds fact by tag (score 3), title (score 2), body (score 1)", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    // Body-only match (score 1) — "match" only in body, not in title or tags
    await memoryWriteTool({ ws, root }).execute({
      content: "untitled\n\nthis contains match in body only",
      tags: [],
    });
    // Tag match (score 3)
    await memoryWriteTool({ ws, root }).execute({ content: "something else", tags: ["match"] });

    const result = await memorySearchTool({ ws, root, searchLimit: 5 }).execute({ query: "match" });
    const parsed = JSON.parse(result.content as string) as Array<{
      title: string;
      tags: string[];
      snippet: string;
    }>;

    // Tag match should come first
    expect(parsed.length).toBe(2);
    expect(parsed[0]?.tags).toContain("match");
  });

  test("title match scores higher than body match", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    // Title contains "priority" (score 2 if title includes query)
    await memoryWriteTool({ ws, root }).execute({
      content: "## priority task\nThe body.",
      tags: [],
    });
    // Only body contains "priority" (score 1)
    await memoryWriteTool({ ws, root }).execute({
      content: "untitled\n\nthis mentions priority in body",
      tags: [],
    });

    const result = await memorySearchTool({ ws, root, searchLimit: 5 }).execute({
      query: "priority",
    });
    const parsed = JSON.parse(result.content as string) as Array<{ title: string }>;

    expect(parsed.length).toBe(2);
    // Title match (score 2) should come before body-only (score 1)
    expect(parsed[0]?.title).toBe("priority task");
  });

  test("respects limit", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    await memoryWriteTool({ ws, root }).execute({ content: "a1", tags: ["word"] });
    await memoryWriteTool({ ws, root }).execute({ content: "a2", tags: ["word"] });
    await memoryWriteTool({ ws, root }).execute({ content: "a3", tags: ["word"] });

    const result = await memorySearchTool({ ws, root, searchLimit: 2 }).execute({ query: "word" });
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toHaveLength(2);
  });

  test("Chinese substring search works", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    await memoryWriteTool({ ws, root }).execute({ content: "用户喜欢简洁回答", tags: ["偏好"] });

    const result = await memorySearchTool({ ws, root, searchLimit: 5 }).execute({ query: "简洁" });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("case-insensitive search", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    await memoryWriteTool({ ws, root }).execute({ content: "UPPERCASE FACT", tags: [] });

    const result = await memorySearchTool({ ws, root, searchLimit: 5 }).execute({
      query: "uppercase",
    });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.length).toBeGreaterThan(0);
  });
});
