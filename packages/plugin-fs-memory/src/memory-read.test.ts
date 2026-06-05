import { describe, expect, test } from "bun:test";
import { writeFact } from "./frontmatter.js";
import { memoryReadTool } from "./memory-read.js";

describe("memory_read", () => {
  test("reads MEMORY.md when no path given", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      await Bun.write(`${dir}/MEMORY.md`, "i am memory");
      const result = await memoryReadTool({ dir }).execute({});
      expect(result.content).toBe("i am memory");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("returns empty string when MEMORY.md missing", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      const result = await memoryReadTool({ dir }).execute({});
      expect(result.content).toBe("");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("reads a specific fact file", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const filepath = await writeFact(dir, { content: "a fact", tags: [] });
      const result = await memoryReadTool({ dir }).execute({ path: filepath });
      expect(result.content).toContain("a fact");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("returns isError when specified path does not exist", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const result = await memoryReadTool({ dir }).execute({ path: "facts/nonexistent.md" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Fact not found");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("returns isError when path escapes memory dir", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      const result = await memoryReadTool({ dir }).execute({ path: "/etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Path escapes");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("accepts absolute path when within memory dir", async () => {
    const dir = `${import.meta.dir}/test-read-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      const absolutePath = `${dir}/facts/legit.md`;
      await Bun.write(absolutePath, '---\nts: 2026-01-01\ntitle: "ok"\ntags: []\n---\nlegit');
      const result = await memoryReadTool({ dir }).execute({ path: absolutePath });
      expect(result.content).toContain("legit");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
