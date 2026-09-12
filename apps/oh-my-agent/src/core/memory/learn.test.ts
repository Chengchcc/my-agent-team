import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillIndex } from "../tools/skills.js";
import { createLearnTool } from "./learn.js";
import { managedSkillsDir } from "./managed-skills.js";

const tmpDirs: string[] = [];
function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-learn-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("learn tool", () => {
  test("captures a lesson newest-first into learned.md", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    const first = (await tool.execute({ memory: "first lesson" })) as { learned: boolean };
    expect(first.learned).toBe(true);
    const second = (await tool.execute({ memory: "second lesson", context: "auth.ts" })) as {
      learned: boolean;
    };
    expect(second.learned).toBe(true);
    const text = readFileSync(join(root, ".oma", "memory", "learned.md"), "utf-8");
    expect(text.indexOf("second lesson")).toBeLessThan(text.indexOf("first lesson"));
    expect(text).toContain("auth.ts");
  });

  test("deduplicates by normalized content", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    await tool.execute({ memory: "  Duplicate  lesson " });
    const dup = (await tool.execute({ memory: "duplicate lesson" })) as { learned: boolean };
    expect(dup.learned).toBe(false);
  });

  test("redacts secret-shaped tokens and rejects empty memory", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    await tool.execute({ memory: "token sk-abcdefghijklmnopqrstuvwxyz123456 leaked" });
    const text = readFileSync(join(root, ".oma", "memory", "learned.md"), "utf-8");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    const empty = (await tool.execute({ memory: "  " })) as { learned: boolean; error: string };
    expect(empty.learned).toBe(false);
    expect(empty.error).toContain("required");
  });
});

describe("learn tool skill minting", () => {
  let agent: string;
  beforeEach(() => {
    agent = mkdtempSync(join(tmpdir(), "oma-learn-agent-"));
    process.env.OMA_CODING_AGENT_DIR = agent;
  });
  afterEach(() => {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(agent, { recursive: true, force: true });
  });

  const skillArg = {
    action: "create" as const,
    name: "release-flow",
    description: "cut a release",
    body: "# Release\n\n1. tag",
  };

  test("skill create mints a managed skill discoverable by buildSkillIndex", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    const res = (await tool.execute({ memory: "lesson one", skill: skillArg })) as {
      learned: boolean;
      skill?: { name: string; path: string };
    };
    expect(res.learned).toBe(true);
    expect(res.skill?.name).toBe("release-flow");
    const file = readFileSync(join(managedSkillsDir(), "release-flow", "SKILL.md"), "utf-8");
    expect(file).toContain("name: release-flow");
    expect(file).toContain("description: cut a release");
    expect(file).toContain("# Release");
    // Round-trip: the minted skill is discoverable as a normal skill.
    const index = buildSkillIndex([managedSkillsDir()]);
    expect(index.map((e) => e.name)).toContain("release-flow");
  });

  test("create fails on an authored skill of the same name; lesson survives", async () => {
    const root = freshWorkspace();
    const authoredRoot = join(root, "authored");
    mkdirSync(join(authoredRoot, "release-flow"), { recursive: true });
    writeFileSync(
      join(authoredRoot, "release-flow", "SKILL.md"),
      "---\nname: release-flow\n---\n\nAuthored.",
    );
    const tool = createLearnTool({ workspaceRoot: root, skillRoots: [authoredRoot] });
    const res = (await tool.execute({ memory: "lesson two", skill: skillArg })) as {
      learned: boolean;
      error?: string;
      isError?: boolean;
    };
    expect(res.learned).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.error).toContain("authored skill");
    // The lesson still won.
    expect(readFileSync(join(root, ".oma", "memory", "learned.md"), "utf-8")).toContain(
      "lesson two",
    );
  });

  test("create on an existing managed skill errors; update rewrites it", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    await tool.execute({ memory: "lesson three", skill: skillArg });
    const dup = (await tool.execute({ memory: "lesson four", skill: skillArg })) as {
      error?: string;
    };
    expect(dup.error).toContain("already exists");
    const upd = (await tool.execute({
      memory: "lesson five",
      skill: { ...skillArg, action: "update", body: "# Release v2" },
    })) as { skill?: { name: string } };
    expect(upd.skill?.name).toBe("release-flow");
    expect(readFileSync(join(managedSkillsDir(), "release-flow", "SKILL.md"), "utf-8")).toContain(
      "# Release v2",
    );
  });

  test("invalid skill name is a partial outcome, not a lost lesson", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    const res = (await tool.execute({
      memory: "lesson six",
      skill: { ...skillArg, name: "../escape" },
    })) as { learned: boolean; error?: string; isError?: boolean };
    expect(res.learned).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.error).toContain("Invalid skill name");
  });

  test("duplicate lesson still mints the skill", async () => {
    const root = freshWorkspace();
    const tool = createLearnTool({ workspaceRoot: root });
    await tool.execute({ memory: "same lesson" });
    const res = (await tool.execute({ memory: "same lesson", skill: skillArg })) as {
      learned: boolean;
      reason?: string;
      skill?: { name: string };
    };
    expect(res.learned).toBe(false);
    expect(res.reason).toContain("duplicate");
    expect(res.skill?.name).toBe("release-flow");
  });
});
