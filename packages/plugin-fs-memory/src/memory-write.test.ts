import { describe, expect, test } from "bun:test";
import { loadAllFactsWithMtimeCache, invalidateFactsCache } from "./cache.js";
import { memoryWriteTool } from "./memory-write.js";

describe("memory_write", () => {
  test("writes a fact file and returns path", async () => {
    const dir = `${import.meta.dir}/test-write-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const result = await memoryWriteTool({ dir }).execute({
        content: "hello world",
        tags: ["test"],
      });
      expect(result.content).toBeDefined();
      const path = JSON.parse(result.content as string).path;
      expect(path).toContain("facts/");
      expect(path).toMatch(/\.md$/);

      // verify file exists
      const exists = await Bun.file(path).exists();
      expect(exists).toBe(true);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("writes file with frontmatter containing title derived from content", async () => {
    const dir = `${import.meta.dir}/test-write-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const result = await memoryWriteTool({ dir }).execute({
        content: "## Important Info\nThe body.",
        tags: ["x"],
      });
      const resp = JSON.parse(result.content as string) as { path: string };
      const raw = await Bun.file(resp.path).text();
      expect(raw).toContain('title: "Important Info"');
      expect(raw).toContain('tags: ["x"]');
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("write then invalidates cache so search can find it", async () => {
    const dir = `${import.meta.dir}/test-write-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    invalidateFactsCache(dir);
    try {
      await memoryWriteTool({ dir }).execute({ content: "cache test", tags: [] });
      // After write, cache should be invalidated — load should re-read
      const facts = await loadAllFactsWithMtimeCache(dir);
      expect(facts.some((f) => f.body === "cache test")).toBe(true);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("writes with same content produce unique filenames", async () => {
    const dir = `${import.meta.dir}/test-write-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const paths = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const r = await memoryWriteTool({ dir }).execute({ content: "dup", tags: [] });
        const p = (JSON.parse(r.content as string) as { path: string }).path;
        paths.add(p);
      }
      expect(paths.size).toBe(3);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
