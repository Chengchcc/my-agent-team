import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { skillLoadTool } from "./skill-load.js";
import { invalidateSkillCache } from "./cache.js";
import { mkdir, writeFile, rm } from "node:fs/promises";

describe("skill_load", () => {
  let dir: string;

  beforeAll(async () => {
    dir = `${import.meta.dir}/test-skill-${crypto.randomUUID()}`;
    await mkdir(`${dir}/test-skill`, { recursive: true });
    await writeFile(
      `${dir}/test-skill/SKILL.md`,
      [
        "---",
        "name: test-skill",
        "description: A test skill for unit tests",
        "---",
        "",
        "# Test Skill",
        "",
        "This is the body of the test skill.",
        "It has multiple paragraphs.",
        "",
        "## Section 2",
        "",
        "More content here.",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads skill body without frontmatter", async () => {
    invalidateSkillCache(dir);
    const tool = skillLoadTool({ dir });
    const result = await tool.execute({ name: "test-skill" });
    expect(result.content).toContain("This is the body of the test skill.");
    expect(result.content).not.toContain("---");
    expect(result.content).not.toContain("A test skill for unit tests");
  });

  test("returns isError when skill not found", async () => {
    invalidateSkillCache(dir);
    const tool = skillLoadTool({ dir });
    const result = await tool.execute({ name: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Skill not found");
  });

  test("offset paging for long body", async () => {
    invalidateSkillCache(dir);
    const tool = skillLoadTool({ dir, maxCharsPerLoad: 30 });
    const r1 = await tool.execute({ name: "test-skill" });
    expect(r1.content).toContain("[Truncated");

    // Extract next offset
    const match = r1.content.match(/offset=(\d+)/);
    expect(match).toBeTruthy();

    const r2 = await tool.execute({ name: "test-skill", offset: parseInt(match![1]!, 10) });
    expect(r2.content).not.toContain("Skill not found");
  });

  test("fully loaded when offset exceeds body", async () => {
    invalidateSkillCache(dir);
    const tool = skillLoadTool({ dir });
    const result = await tool.execute({ name: "test-skill", offset: 99999 });
    expect(result.content).toContain("fully loaded");
  });
});
