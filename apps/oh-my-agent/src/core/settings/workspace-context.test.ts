import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextDirChain,
  readWorkspaceSystemPrompt,
  scanWorkspaceSkillRoots,
} from "./workspace-context.js";

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

  test("identity files come first, then the AGENTS.md chain in <file> markers", () => {
    const dir = workspace();
    writeFileSync(join(dir, "USER.md"), "user context");
    writeFileSync(join(dir, "AGENTS.md"), "instructions");
    writeFileSync(join(dir, "SOUL.md"), "identity");
    const prompt = readWorkspaceSystemPrompt(dir) ?? "";
    expect(prompt.indexOf("identity")).toBeLessThan(prompt.indexOf("user context"));
    // AGENTS.md is project context now: wrapped, path-marked, after identity.
    expect(prompt).toContain(`<file path="${join(dir, "AGENTS.md")}">`);
    expect(prompt.indexOf("user context")).toBeLessThan(prompt.indexOf("instructions"));
  });

  test("ancestor AGENTS.md files load far-first up to the repo root (.git)", () => {
    const repo = workspace();
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "AGENTS.md"), "root rules");
    writeFileSync(join(repo, "apps", "web", "AGENTS.md"), "web rules");
    const prompt = readWorkspaceSystemPrompt(join(repo, "apps", "web")) ?? "";
    const rootAt = prompt.indexOf("root rules");
    const webAt = prompt.indexOf("web rules");
    expect(rootAt).toBeGreaterThan(-1);
    // Far ancestors first: the cwd's file is more prominent (nearer the end).
    expect(rootAt).toBeLessThan(webAt);
    expect(prompt).toContain(`<file path="${join(repo, "AGENTS.md")}">`);
    expect(prompt).toContain("<repo-rules>");
  });

  test("without a repo root, home is the inclusive boundary", () => {
    const fakeHome = workspace();
    mkdirSync(join(fakeHome, "a", "b"), { recursive: true });
    writeFileSync(join(fakeHome, "AGENTS.md"), "home rules");
    writeFileSync(join(fakeHome, "a", "AGENTS.md"), "a rules");
    const prompt =
      readWorkspaceSystemPrompt(join(fakeHome, "a", "b"), {
        home: fakeHome,
      }) ?? "";
    // Chain = b, a, home: all three survive (different content).
    expect(prompt).toContain("home rules");
    expect(prompt).toContain("a rules");
  });

  test("byte-identical files collapse to the nearest copy", () => {
    const repo = workspace();
    mkdirSync(join(repo, "pkg"), { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "AGENTS.md"), "same content");
    writeFileSync(join(repo, "pkg", "AGENTS.md"), "same content");
    const prompt = readWorkspaceSystemPrompt(join(repo, "pkg")) ?? "";
    expect(prompt.split("same content").length - 1).toBe(1);
    // The surviving (more prominent) copy is the cwd-level one.
    expect(prompt).toContain(`<file path="${join(repo, "pkg", "AGENTS.md")}">`);
  });

  test("deeper AGENTS.md files are listed as pointers, not injected", () => {
    const dir = workspace();
    mkdirSync(join(dir, "apps"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "root rules");
    writeFileSync(join(dir, "apps", "AGENTS.md"), "app rules");
    const prompt = readWorkspaceSystemPrompt(dir) ?? "";
    expect(prompt).toContain("<dir-context>");
    expect(prompt).toContain(`<file path="${join(dir, "apps", "AGENTS.md")}" />`);
    // Pointer = path only; the content is not injected.
    expect(prompt).not.toContain(">app rules<");
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
    expect(readWorkspaceSystemPrompt(dir)).toContain("instructions");
  });
});

describe("contextDirChain", () => {
  test("stops at the repo root (.git), inclusive; home never entered", () => {
    const repo = workspace();
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    mkdirSync(join(repo, ".git"));
    const chain = contextDirChain(join(repo, "a", "b"), { home: "/nonexistent-home" });
    expect(chain).toEqual([join(repo, "a", "b"), join(repo, "a"), repo]);
  });

  test("no repo root: home is the inclusive boundary", () => {
    const home = workspace();
    mkdirSync(join(home, "a"), { recursive: true });
    const chain = contextDirChain(join(home, "a"), { home });
    expect(chain).toEqual([join(home, "a"), home]);
  });

  test("cwd === home stops immediately (home itself is a boundary)", () => {
    const home = workspace();
    const chain = contextDirChain(home, { home });
    expect(chain).toEqual([home]);
  });
});

describe("user-scope context file (<agentDir>/AGENTS.md)", () => {
  test("loads last and shadows nothing when unique", () => {
    const dir = workspace();
    const saved = process.env.OMA_CODING_AGENT_DIR;
    const agentHome = workspace();
    process.env.OMA_CODING_AGENT_DIR = agentHome;
    try {
      writeFileSync(join(agentHome, "AGENTS.md"), "personal prefs");
      writeFileSync(join(dir, "AGENTS.md"), "project rules");
      const prompt = readWorkspaceSystemPrompt(dir) ?? "";
      expect(prompt).toContain("personal prefs");
      expect(prompt.indexOf("project rules")).toBeLessThan(prompt.indexOf("personal prefs"));
    } finally {
      if (saved === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = saved;
    }
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

    // readdir order is filesystem-dependent (this passed locally and failed
    // on CI with the two entries swapped): the contract is WHICH entries come
    // back, not their order — the skill plugin sorts for the prompt index.
    const found = scanWorkspaceSkillRoots(dir)
      .map((p) => p.split("/").pop())
      .sort();
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
