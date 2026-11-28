import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionCheckpoint,
  captureCheckpointTree,
  captureCheckpointTreeAsync,
  diffWorkspaceAgainstTree,
  isGitWorkspace,
  loadSessionCheckpoints,
  restoreCheckpointTree,
  restoreFileFromTree,
} from "./checkpoints.js";
import { sessionFilePath } from "./session-paths.js";

const tmpDirs: string[] = [];
function makeTmpDir(prefix = "oma-ckpt-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("session checkpoints (git shadow tree)", () => {
  test("non-git directories fail cleanly across capture, restore, and diff", async () => {
    const plain = makeTmpDir("oma-nongit-");
    expect(isGitWorkspace(plain)).toBe(false);
    expect(captureCheckpointTree(plain)).toBeNull();
    expect(await captureCheckpointTreeAsync(plain)).toBeNull();
    expect(restoreCheckpointTree(plain, "deadbeef")).toMatchObject({
      ok: false,
      error: "not a git repository",
    });
    expect(restoreFileFromTree(plain, "deadbeef", "a.txt")).toMatchObject({
      ok: false,
      error: "not a git repository",
    });
    expect(diffWorkspaceAgainstTree(plain)).toMatchObject({
      ok: false,
      error: "not a git repository",
    });
  });

  test("captureCheckpointTreeAsync works in unborn repos and committed repos", async () => {
    const repo = makeTmpDir("oma-git-");
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "hello.txt"), "v1\n");

    // Unborn repo (no HEAD yet)
    const unbornSha = await captureCheckpointTreeAsync(repo);
    expect(unbornSha).toMatch(/^[0-9a-f]{40}$/);
    // Diff with no baseline & no HEAD falls back to `git status --short`
    const unbornDiff = diffWorkspaceAgainstTree(repo);
    expect(unbornDiff.ok).toBe(true);
    expect(unbornDiff.stat).toContain("hello.txt");

    // Committed repo
    git(repo, "add", "hello.txt");
    git(repo, "commit", "-m", "init");
    const committedSha = await captureCheckpointTreeAsync(repo);
    expect(committedSha).toMatch(/^[0-9a-f]{40}$/);

    // Modify + add an extra file, then diff (whole repo & single file)
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    writeFileSync(join(repo, "extra.txt"), "new\n");
    const wholeDiff = diffWorkspaceAgainstTree(repo, committedSha!);
    expect(wholeDiff.ok).toBe(true);
    expect(wholeDiff.stat).toContain("hello.txt");
    expect(wholeDiff.patch).toBe("");

    const fileDiff = diffWorkspaceAgainstTree(repo, committedSha!, "hello.txt");
    expect(fileDiff.ok).toBe(true);
    expect(fileDiff.patch).toContain("+v2");

    // restoreFileFromTree removes a file absent from the checkpoint tree
    const removed = restoreFileFromTree(repo, committedSha!, "extra.txt");
    expect(removed).toEqual({ ok: true, action: "removed" });
    expect(existsSync(join(repo, "extra.txt"))).toBe(false);

    // restoreFileFromTree restores a modified file
    const restored = restoreFileFromTree(repo, committedSha!, "hello.txt");
    expect(restored).toEqual({ ok: true, action: "restored" });
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("v1\n");

    // Invalid tree SHA fails cleanly
    expect(restoreCheckpointTree(repo, "0000000000000000000000000000000000000000").ok).toBe(false);
    expect(
      restoreFileFromTree(repo, "0000000000000000000000000000000000000000", "hello.txt").ok,
    ).toBe(false);
  });

  test("appendSessionCheckpoint and loadSessionCheckpoints round-trip and skip malformed lines", () => {
    const dir = makeTmpDir("oma-sess-");
    const sessionId = "sess-ckpt-1";

    // Missing file: load returns [], append is a no-op
    expect(loadSessionCheckpoints(sessionId, dir)).toEqual([]);
    appendSessionCheckpoint(
      sessionId,
      { turn: 1, prompt: "ignored", treeSha: "a".repeat(40) },
      dir,
    );
    expect(loadSessionCheckpoints(sessionId, dir)).toEqual([]);

    // Existing session file
    const path = sessionFilePath(sessionId, dir);
    writeFileSync(path, `${JSON.stringify({ type: "meta", sessionId })}\nnot-json\n`);
    appendSessionCheckpoint(
      sessionId,
      { turn: 1, prompt: "fix   the\nbug", treeSha: "a".repeat(40) },
      dir,
    );
    appendFileSync(
      path,
      `${JSON.stringify({ type: "checkpoint", turn: 2, treeSha: "b".repeat(40) })}\n`,
    );

    const loaded = loadSessionCheckpoints(sessionId, dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ turn: 1, prompt: "fix the bug", treeSha: "a".repeat(40) });
    expect(loaded[1]).toMatchObject({ turn: 2, prompt: "", treeSha: "b".repeat(40) });
  });
});
