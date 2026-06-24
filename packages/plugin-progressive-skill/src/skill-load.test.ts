import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
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

    const tool = skillLoadTool({ ws, roots: [root] });
    const result = await tool.execute({ name: "test-skill" });
    expect(result.content).toContain("This is the body of the test skill.");
    expect(result.content).not.toContain("---");
    expect(result.content).not.toContain("A test skill for unit tests");
  });

  test("returns isError when skill not found", async () => {
    const ws = testFS();
    const root = "/skills/";
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, roots: [root] });
    const result = await tool.execute({ name: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Skill not found");
  });

  test("offset paging for long body", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/test-skill/SKILL.md", testSkillMd);
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, roots: [root], maxCharsPerLoad: 30 });
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

    const tool = skillLoadTool({ ws, roots: [root] });
    const result = await tool.execute({ name: "test-skill", offset: 99999 });
    expect(result.content).toContain("fully loaded");
  });

  test("${SKILL_DIR} resolves to posixRoot when provided", async () => {
    const ws = testFS();
    const root = "/skills/";
    const posixSkillRoot = "/real/path/skills";
    await ws.write(
      "/skills/demo/SKILL.md",
      [
        "---",
        "name: demo",
        "description: Tests posixRoot mapping",
        "---",
        "",
        "Run: python ${SKILL_DIR}/script.py",
        "Also: bash ${SKILL_DIR}/tools/helper.sh",
      ].join("\n"),
    );
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, roots: [root], posixSkillRoot });
    const result = await tool.execute({ name: "demo" });
    expect(result.content).toContain("python /real/path/skills/demo/script.py");
    expect(result.content).toContain("bash /real/path/skills/demo/tools/helper.sh");
    expect(result.content).not.toContain("${SKILL_DIR}");
  });

  test("${SKILL_DIR} falls back to logical path when posixSkillRoot is missing", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/demo/SKILL.md",
      ["---", "name: demo", "description: Test fallback", "---", "", "Use: ${SKILL_DIR}/x"].join(
        "\n",
      ),
    );
    invalidateSkillCache(root);

    const tool = skillLoadTool({ ws, roots: [root] }); // no posixSkillRoot
    const result = await tool.execute({ name: "demo" });
    expect(result.content).toContain("Use: /skills/demo/x");
    expect(result.content).not.toContain("${SKILL_DIR}");
  });
});
