import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { invalidateSkillCache, loadSkillIndexWithMtimeCache } from "./cache.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("frontmatter tolerance", () => {
  test("single SKILL.md parse failure → skipped with warn, others continue", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/good-skill/SKILL.md",
      ["---", "name: good-skill", "description: works fine", "---", "", "body"].join("\n"),
    );
    await ws.write("/skills/bad-skill/SKILL.md", "no frontmatter here\njust body");
    invalidateSkillCache(root);

    const warnings: { msg: string; err?: unknown }[] = [];
    const logger = {
      warn: (msg: string, err?: unknown) => {
        warnings.push({ msg, err });
      },
    };

    const skills = await loadSkillIndexWithMtimeCache(ws, root, logger);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("good-skill");
    expect(warnings.some((w) => w.msg.includes("bad-skill"))).toBe(true);
  });

  test("missing name in frontmatter → treated as failure", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/no-name/SKILL.md",
      ["---", "description: no name field", "---", "", "body"].join("\n"),
    );
    invalidateSkillCache(root);

    const logger = { warn: () => {} };
    const skills = await loadSkillIndexWithMtimeCache(ws, root, logger);
    expect(skills).toHaveLength(0);
  });
});
