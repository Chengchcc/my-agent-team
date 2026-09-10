import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceSystemPrompt, scanWorkspaceSkillRoots } from "./workspace-context.js";

/** cwd-based workspace context is the FALLBACK path for a run whose input
 *  carries no explicit systemPrompt/skillRoots (standalone modes). Its failure
 *  modes are all silent (a missing AGENTS.md would just mean "no prompt"), so
 *  the shape it produces is worth pinning. */
const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-wsctx-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("readWorkspaceSystemPrompt", () => {
  test("no workspace files at all = undefined (not an empty prompt)", () => {
    expect(readWorkspaceSystemPrompt(workspace())).toBeUndefined();
  });

  test("AGENTS.md, SOUL.md and USER.md are concatenated in that order", () => {
    const dir = workspace();
    writeFileSync(join(dir, "USER.md"), "user context");
    writeFileSync(join(dir, "AGENTS.md"), "instructions");
    writeFileSync(join(dir, "SOUL.md"), "identity");
    const prompt = readWorkspaceSystemPrompt(dir) ?? "";
    expect(prompt.indexOf("instructions")).toBeLessThan(prompt.indexOf("identity"));
    expect(prompt.indexOf("identity")).toBeLessThan(prompt.indexOf("user context"));
  });

  test("blank files are skipped, and one file is still a prompt", () => {
    const dir = workspace();
    writeFileSync(join(dir, "AGENTS.md"), "   \n\n  ");
    writeFileSync(join(dir, "SOUL.md"), "identity");
    expect(readWorkspaceSystemPrompt(dir)).toBe("identity");
  });

  test("the knowledge index is appended as reference material, tagged", () => {
    const dir = workspace();
    writeFileSync(join(dir, "AGENTS.md"), "instructions");
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "knowledge", "index.md"), "\n- pack: alpha\n");
    const prompt = readWorkspaceSystemPrompt(dir) ?? "";
    expect(prompt).toContain("<available_knowledge>");
    expect(prompt).toContain("- pack: alpha");
    expect(prompt).toContain("</available_knowledge>");
  });

  test("a whitespace-only knowledge index is not appended", () => {
    const dir = workspace();
    writeFileSync(join(dir, "AGENTS.md"), "instructions");
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "knowledge", "index.md"), "  \n");
    expect(readWorkspaceSystemPrompt(dir)).toBe("instructions");
  });
});

describe("scanWorkspaceSkillRoots", () => {
  test("missing .oma/skills is an empty list, not an error", () => {
    expect(scanWorkspaceSkillRoots(workspace())).toEqual([]);
  });

  test("returns only directories, and follows a symlinked pack", () => {
    const dir = workspace();
    const skills = join(dir, ".oma", "skills");
    mkdirSync(join(skills, "real-pack"), { recursive: true });
    writeFileSync(join(skills, "loose-file.md"), "not a pack");
    const external = workspace();
    symlinkSync(external, join(skills, "linked-pack"));

    const found = scanWorkspaceSkillRoots(dir).map((p) => p.split("/").pop());
    expect(found).toEqual(["linked-pack", "real-pack"]);
  });

  test("a dangling symlink is skipped, not thrown", () => {
    const dir = workspace();
    const skills = join(dir, ".oma", "skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync(join(dir, "does-not-exist"), join(skills, "dangling"));
    expect(scanWorkspaceSkillRoots(dir)).toEqual([]);
  });
});
