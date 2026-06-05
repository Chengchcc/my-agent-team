import { describe, expect, test } from "bun:test";
import { memorySearchTool } from "./memory-search.js";
import { memoryWriteTool } from "./memory-write.js";
import { invalidateFactsCache } from "./cache.js";

describe("memory_search", () => {
  test("returns empty array when no match", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      const result = await memorySearchTool({ dir, searchLimit: 5 }).execute({ query: "nothing" });
      const parsed = JSON.parse(result.content as string);
      expect(parsed).toEqual([]);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("finds fact by tag (score 3), title (score 2), body (score 1)", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      // Body-only match (score 1) — "match" only in body, not in title or tags
      await memoryWriteTool({ dir }).execute({
        content: "untitled\n\nthis contains match in body only",
        tags: [],
      });
      // Tag match (score 3)
      await memoryWriteTool({ dir }).execute({ content: "something else", tags: ["match"] });

      const result = await memorySearchTool({ dir, searchLimit: 5 }).execute({ query: "match" });
      const parsed = JSON.parse(result.content as string) as Array<{
        title: string;
        tags: string[];
        snippet: string;
      }>;

      // Tag match should come first
      expect(parsed.length).toBe(2);
      expect(parsed[0]!.tags).toContain("match");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("title match scores higher than body match", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      // Title contains "priority" (score 2 if title includes query)
      await memoryWriteTool({ dir }).execute({ content: "## priority task\nThe body.", tags: [] });
      // Only body contains "priority" (score 1)
      await memoryWriteTool({ dir }).execute({
        content: "untitled\n\nthis mentions priority in body",
        tags: [],
      });

      const result = await memorySearchTool({ dir, searchLimit: 5 }).execute({ query: "priority" });
      const parsed = JSON.parse(result.content as string) as Array<{ title: string }>;

      expect(parsed.length).toBe(2);
      // Title match (score 2) should come before body-only (score 1)
      expect(parsed[0]!.title).toBe("priority task");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("respects limit", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      await memoryWriteTool({ dir }).execute({ content: "a1", tags: ["word"] });
      await memoryWriteTool({ dir }).execute({ content: "a2", tags: ["word"] });
      await memoryWriteTool({ dir }).execute({ content: "a3", tags: ["word"] });

      const result = await memorySearchTool({ dir, searchLimit: 2 }).execute({ query: "word" });
      const parsed = JSON.parse(result.content as string);
      expect(parsed).toHaveLength(2);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("Chinese substring search works", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      await memoryWriteTool({ dir }).execute({ content: "用户喜欢简洁回答", tags: ["偏好"] });

      const result = await memorySearchTool({ dir, searchLimit: 5 }).execute({ query: "简洁" });
      const parsed = JSON.parse(result.content as string);
      expect(parsed.length).toBeGreaterThan(0);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("case-insensitive search", async () => {
    const dir = `${import.meta.dir}/test-search-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache();
    try {
      await memoryWriteTool({ dir }).execute({ content: "UPPERCASE FACT", tags: [] });

      const result = await memorySearchTool({ dir, searchLimit: 5 }).execute({
        query: "uppercase",
      });
      const parsed = JSON.parse(result.content as string);
      expect(parsed.length).toBeGreaterThan(0);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
