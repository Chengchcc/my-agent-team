import { describe, expect, test } from "bun:test";
import { MemoryBackend, AgentFS } from "@my-agent-team/agent-fs";
import { invalidateSkillCache } from "./cache.js";
import { skillLoadTool } from "./skill-load.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

const testSkillMd = [
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
].join("\n");

describe("skill_load", () => {
  test("loads skill body without frontmatter", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/test-skill/SKILL.md", testSkillMd);
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, root });
    const result = await tool.execute({ name: "test-skill" });
    expect(result.content).toContain("This is the body of the test skill.");
    expect(result.content).not.toContain("---");
    expect(result.content).not.toContain("A test skill for unit tests");
  });

  test("returns isError when skill not found", async () => {
    const ws = testFS();
    const root = "/skills/";
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, root });
    const result = await tool.execute({ name: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Skill not found");
  });

  test("offset paging for long body", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/test-skill/SKILL.md", testSkillMd);
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, root, maxCharsPerLoad: 30 });
    const r1 = await tool.execute({ name: "test-skill" });
    expect(r1.content).toContain("[Truncated");

    // Extract next offset
    const match = r1.content.match(/offset=(\d+)/);
    expect(match).toBeTruthy();

    const r2 = await tool.execute({ name: "test-skill", offset: parseInt(match?.[1] ?? "0", 10) });
    expect(r2.content).not.toContain("Skill not found");
  });

  test("fully loaded when offset exceeds body", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/test-skill/SKILL.md", testSkillMd);
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, root });
    const result = await tool.execute({ name: "test-skill", offset: 99999 });
    expect(result.content).toContain("fully loaded");
  });
});
