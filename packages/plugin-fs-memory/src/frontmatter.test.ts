import { describe, expect, test } from "bun:test";
import { readFact, writeFact } from "./frontmatter.js";

describe("frontmatter", () => {
  test("writeFact writes frontmatter + body", async () => {
    const dir = `${import.meta.dir}/test-tmp-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();

    try {
      const filepath = await writeFact(dir, { content: "hello world", tags: ["greeting"] });

      const raw = await Bun.file(filepath).text();
      expect(raw).toContain("---");
      expect(raw).toContain('tags: ["greeting"]');
      // title derived from first line
      expect(raw).toContain('title: "hello world"');
      expect(raw).toContain("hello world");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("writeFact derives title from first non-empty line, stripping # prefix", async () => {
    const dir = `${import.meta.dir}/test-tmp-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();

    try {
      const filepath = await writeFact(dir, {
        content: "## Important Note\nThe body text.",
        tags: [],
      });

      const raw = await Bun.file(filepath).text();
      expect(raw).toContain('title: "Important Note"');
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("writeFact generates unique filenames even with same content", async () => {
    const dir = `${import.meta.dir}/test-tmp-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();

    try {
      const paths = new Set<string>();
      // Write same content multiple times — filenames should be unique
      for (let i = 0; i < 5; i++) {
        const p = await writeFact(dir, { content: "dup content", tags: [] });
        paths.add(p);
      }
      expect(paths.size).toBe(5);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("readFact returns parsed frontmatter + body", async () => {
    const dir = `${import.meta.dir}/test-tmp-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();

    try {
      const filepath = await writeFact(dir, { content: "my fact body", tags: ["tag1", "tag2"] });

      const fact = await readFact(filepath);
      expect(fact.title).toBe("my fact body");
      expect(fact.tags).toEqual(["tag1", "tag2"]);
      expect(fact.body).toBe("my fact body");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("readFact old fact without title uses basename fallback", async () => {
    const dir = `${import.meta.dir}/test-tmp-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();

    try {
      const filepath = `${dir}/facts/2026-06-05T14-00-00-000Z-old-fact.md`;
      await Bun.write(
        filepath,
        `---\nts: "2026-06-05T14-00-00-000Z"\ntags: ["old"]\n---\nold body content`,
      );

      const fact = await readFact(filepath);
      expect(fact.title).toBe("2026-06-05T14-00-00-000Z-old-fact");
      expect(fact.tags).toEqual(["old"]);
      expect(fact.body).toBe("old body content");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
