import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { invalidateSkillCache, loadSkillIndexWithMtimeCache } from "./cache.js";

describe("frontmatter tolerance", () => {
  let dir: string;

  beforeAll(async () => {
    dir = `${import.meta.dir}/test-tol-${crypto.randomUUID()}`;
    await mkdir(`${dir}/good-skill`, { recursive: true });
    await mkdir(`${dir}/bad-skill`, { recursive: true });
    await writeFile(
      `${dir}/good-skill/SKILL.md`,
      ["---", "name: good-skill", "description: works fine", "---", "", "body"].join("\n"),
    );
    await writeFile(`${dir}/bad-skill/SKILL.md`, "no frontmatter here\njust body");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("single SKILL.md parse failure → skipped with warn, others continue", async () => {
    invalidateSkillCache(dir);
    const warnings: { msg: string; err?: unknown }[] = [];
    const logger = {
      warn: (msg: string, err?: unknown) => {
        warnings.push({ msg, err });
      },
    };

    const skills = await loadSkillIndexWithMtimeCache(dir, logger);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("good-skill");
    expect(warnings.some((w) => w.msg.includes("bad-skill"))).toBe(true);
  });

  test("missing name in frontmatter → treated as failure", async () => {
    const tmpDir = `${import.meta.dir}/test-tol2-${crypto.randomUUID()}`;
    await mkdir(`${tmpDir}/no-name`, { recursive: true });
    try {
      await writeFile(
        `${tmpDir}/no-name/SKILL.md`,
        ["---", "description: no name field", "---", "", "body"].join("\n"),
      );
      invalidateSkillCache(tmpDir);
      const logger = { warn: () => {} };
      const skills = await loadSkillIndexWithMtimeCache(tmpDir, logger);
      expect(skills).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
