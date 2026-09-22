import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTaskWorktrees, validateWorktreePath } from "./task-worktrees.js";

const dir = mkdtempSync(join(tmpdir(), "taskwt-helpers-"));

function agentWorkspace(name: string): string {
  const ws = join(dir, name);
  mkdirSync(join(ws, "projects"), { recursive: true });
  return ws;
}

describe("listTaskWorktrees", () => {
  test("finds slug dirs across agents, skips main worktrees and junk", () => {
    const wsA = agentWorkspace("a");
    const wsB = agentWorkspace("b");
    writeFileSync(join(wsA, "projects", "p1.feat-x"), "");
    mkdirSync(join(wsA, "projects", "p1.feat-y"), { recursive: true });
    // main worktree (no dot-suffix), another project's, junk suffixes
    mkdirSync(join(wsA, "projects", "p1"), { recursive: true });
    mkdirSync(join(wsA, "projects", "other.feat-z"), { recursive: true });
    mkdirSync(join(wsA, "projects", "p1.bad slug!"), { recursive: true });
    mkdirSync(join(wsB, "projects", "p1.task-9"), { recursive: true });

    const list = listTaskWorktrees("p1", [
      { id: "a1", workspacePath: wsA },
      { id: "b1", workspacePath: wsB },
    ]);
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.slug).sort()).toEqual(["feat-y", "task-9"]);
    expect(list.find((w) => w.slug === "task-9")?.agentId).toBe("b1");
  });

  test("a missing projects dir is an empty list, not an error", () => {
    expect(listTaskWorktrees("p1", [{ id: "a", workspacePath: join(dir, "nope") }])).toEqual([]);
  });
});

describe("validateWorktreePath", () => {
  const ws = agentWorkspace("v");
  const main = join(ws, "projects", "p1");

  test("accepts the main worktree and slug dirs of the SAME agent/project", () => {
    expect(validateWorktreePath(ws, "p1", main)).toBe(main);
    const task = join(ws, "projects", "p1.feat-x");
    expect(validateWorktreePath(ws, "p1", task)).toBe(task);
  });

  test("rejects arbitrary cwd, other projects, traversal, and bad slugs", () => {
    expect(() => validateWorktreePath(ws, "p1", "/etc")).toThrow();
    expect(() => validateWorktreePath(ws, "p1", join(ws, "projects", "other.feat"))).toThrow();
    expect(() => validateWorktreePath(ws, "p1", join(ws, "projects", "p1", "escape"))).toThrow();
    expect(() => validateWorktreePath(ws, "p1", join(ws, "projects", "p1.."))).toThrow();
  });

  test("undefined passes through", () => {
    expect(validateWorktreePath(ws, "p1", undefined)).toBeUndefined();
  });
});

rmSync(dir, { recursive: true, force: true });
