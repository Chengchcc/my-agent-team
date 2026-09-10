import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearnTool } from "./learn.js";

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
