import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceEscapeError, WorkspaceSandbox } from "./workspace-sandbox.js";

const tmpRoot = `/tmp/sandbox-test-${Math.random().toString(36).slice(2, 8)}`;
const outsideFile = `/tmp/sandbox-outside-${Math.random().toString(36).slice(2, 8)}.txt`;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "subdir"), { recursive: true });
  writeFileSync(join(tmpRoot, "inside.txt"), "hello");
  writeFileSync(join(tmpRoot, "subdir", "nested.txt"), "nested");
  writeFileSync(outsideFile, "secret");
  // Create symlink pointing outside
  try {
    symlinkSync(outsideFile, join(tmpRoot, "escape-link"));
  } catch {
    /* may not have permissions */
  }
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true });
  } catch {
    /* */
  }
  try {
    rmSync(outsideFile);
  } catch {
    /* */
  }
});

describe("WorkspaceSandbox", () => {
  test("accepts contained paths", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(sandbox.validate("inside.txt")).toContain("inside.txt");
    expect(sandbox.validate("subdir/nested.txt")).toContain("nested.txt");
  });

  test("rejects parent traversal", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate("../../../etc/passwd")).toThrow(WorkspaceEscapeError);
    expect(() => sandbox.validate("../../outside")).toThrow(WorkspaceEscapeError);
  });

  test("rejects absolute paths outside root", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate(outsideFile)).toThrow(WorkspaceEscapeError);
    expect(() => sandbox.validate("/etc/passwd")).toThrow(WorkspaceEscapeError);
  });

  test("rejects prefix collision", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    // A directory named like tmpRoot + "-evil" should not match
    const evilPath = `${tmpRoot}-evil/secret`;
    expect(() => sandbox.validate(evilPath)).toThrow(WorkspaceEscapeError);
  });

  test("validateCwd accepts contained directory", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(sandbox.validateCwd("subdir")).toContain("subdir");
  });

  test("validateCwd rejects outside directory", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validateCwd("/tmp")).toThrow(WorkspaceEscapeError);
  });

  test("rejects symlink escape if symlink exists", () => {
    if (!existsSync(join(tmpRoot, "escape-link"))) return;
    const sandbox = new WorkspaceSandbox(tmpRoot);
    expect(() => sandbox.validate("escape-link")).toThrow(WorkspaceEscapeError);
  });

  test("validateNew rejects writing through a symlinked parent", () => {
    // A symlinked directory inside the root pointing outside; writing a new
    // file through it must be rejected even though the leaf does not exist.
    const outsideDir = `/tmp/sandbox-outside-dir-${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(outsideDir);
      symlinkSync(outsideDir, join(tmpRoot, "escape-dir"));
      const sandbox = new WorkspaceSandbox(tmpRoot);
      expect(() => sandbox.validateNew("escape-dir/new.txt")).toThrow(WorkspaceEscapeError);
      expect(() => sandbox.validateNew("escape-dir/sub/new.txt")).toThrow(WorkspaceEscapeError);
    } finally {
      try {
        rmSync(join(tmpRoot, "escape-dir"));
      } catch {
        /* */
      }
      try {
        rmSync(outsideDir, { recursive: true });
      } catch {
        /* */
      }
    }
  });

  test("handles dangling symlinks, relative symlink chains, loops, and ENOTDIR", () => {
    const sandbox = new WorkspaceSandbox(tmpRoot);
    const links = [
      join(tmpRoot, "rel-dangling-in"),
      join(tmpRoot, "rel-dangling-out"),
      join(tmpRoot, "dir-alias"),
      join(tmpRoot, "loop-a"),
      join(tmpRoot, "loop-b"),
      join(tmpRoot, "abs-dangling-out"),
      join(tmpRoot, "abs-dangling-in"),
    ];
    try {
      // Relative dangling symlink staying inside root resolves to canonical target
      symlinkSync("./subdir/not-yet.txt", links[0]!);
      expect(sandbox.validateNew("rel-dangling-in")).toBe(
        join(sandbox.root, "subdir", "not-yet.txt"),
      );

      // Relative dangling symlink escaping root is refused
      symlinkSync("../../outside-dangling.txt", links[1]!);
      expect(() => sandbox.validateNew("rel-dangling-out")).toThrow(WorkspaceEscapeError);

      // Absolute dangling symlinks: escaping is refused, contained resolves cleanly
      symlinkSync("/tmp/definitely-outside-dangling.txt", links[5]!);
      expect(() => sandbox.validateNew("abs-dangling-out")).toThrow(WorkspaceEscapeError);
      symlinkSync(join(sandbox.root, "subdir", "abs-not-yet.txt"), links[6]!);
      expect(sandbox.validateNew("abs-dangling-in")).toBe(
        join(sandbox.root, "subdir", "abs-not-yet.txt"),
      );

      // In-workspace directory symlink resolves nested children to canonical realpath
      symlinkSync("subdir", links[2]!);
      expect(sandbox.validate("dir-alias/nested.txt")).toBe(
        join(sandbox.root, "subdir", "nested.txt"),
      );

      // Symlink cycle exceeds MAX_SYMLINK_HOPS and fails closed
      symlinkSync("loop-b", links[3]!);
      symlinkSync("loop-a", links[4]!);
      expect(() => sandbox.validateNew("loop-a")).toThrow(WorkspaceEscapeError);

      // Traversing through a regular file triggers ENOTDIR -> fails closed
      expect(() => sandbox.validateNew("inside.txt/child")).toThrow(WorkspaceEscapeError);
    } finally {
      for (const l of links) {
        try {
          rmSync(l, { force: true });
        } catch {
          /* */
        }
      }
    }
  });
});
