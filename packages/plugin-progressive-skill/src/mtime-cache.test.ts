import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { loadSkillIndexWithMtimeCache, invalidateSkillCache } from "./cache.js";
import { mkdir, writeFile, rm } from "node:fs/promises";

describe("mtime cache", () => {
  let dir: string;

  beforeAll(async () => {
    dir = `${import.meta.dir}/test-cache-${crypto.randomUUID()}`;
    await mkdir(`${dir}/alpha`, { recursive: true });
    await writeFile(
      `${dir}/alpha/SKILL.md`,
      ["---", "name: alpha", "description: first skill", "---", "", "body"].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("second call serves from cache", async () => {
    invalidateSkillCache();
    const first = await loadSkillIndexWithMtimeCache(dir);
    const second = await loadSkillIndexWithMtimeCache(dir);
    expect(second).toBe(first); // same array reference
  });

  test("invalidate forces re-read", async () => {
    invalidateSkillCache();
    const first = await loadSkillIndexWithMtimeCache(dir);
    invalidateSkillCache();
    const second = await loadSkillIndexWithMtimeCache(dir);
    expect(second).not.toBe(first);
  });

  test("new skill directory added triggers re-read via dir mtime change", async () => {
    invalidateSkillCache();
    const first = await loadSkillIndexWithMtimeCache(dir);
    expect(first.length).toBeGreaterThanOrEqual(1);

    // Add a new skill directory — this changes dir mtime
    await mkdir(`${dir}/beta`, { recursive: true });
    await writeFile(
      `${dir}/beta/SKILL.md`,
      ["---", "name: beta", "description: second skill", "---", "", "body"].join("\n"),
    );

    const second = await loadSkillIndexWithMtimeCache(dir);
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.some((s) => s.name === "beta")).toBe(true);
  });
});
