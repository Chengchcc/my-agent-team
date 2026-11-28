import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDir, sessionFilePath } from "./session-paths.js";

export interface SessionCheckpoint {
  readonly turn: number;
  readonly prompt: string;
  readonly treeSha: string;
  readonly timestamp: string;
}

function runGit(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

async function runGitAsync(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

/** True when `cwd` sits inside a git working tree. */
export function isGitWorkspace(cwd: string): boolean {
  const res = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

/** Async version of `captureCheckpointTree` using `Bun.spawn` so the TUI Enter
 *  submit path NEVER blocks the event loop with synchronous subprocess spawns. */
export async function captureCheckpointTreeAsync(cwd: string): Promise<string | null> {
  const check = await runGitAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") return null;
  const tmpIndex = join(tmpdir(), `oma-ckpt-${process.pid}-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const hasHead = (await runGitAsync(cwd, ["rev-parse", "--verify", "HEAD"])).ok;
    if (hasHead) {
      if (!(await runGitAsync(cwd, ["read-tree", "HEAD"], env)).ok) return null;
    }
    if (!(await runGitAsync(cwd, ["add", "-A"], env)).ok) return null;
    const write = await runGitAsync(cwd, ["write-tree"], env);
    if (!write.ok) return null;
    const sha = write.stdout.trim();
    return /^[0-9a-f]{40,}$/i.test(sha) ? sha : null;
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Capture the full working-tree state (tracked + untracked non-ignored files)
 *  as a git tree SHA using a temporary index file. NEVER touches `.git/index`,
 *  the stash, or ignored files (node_modules, .env, dist). Returns null when
 *  `cwd` is not a git repo or git fails. */
export function captureCheckpointTree(cwd: string): string | null {
  if (!isGitWorkspace(cwd)) return null;
  const tmpIndex = join(tmpdir(), `oma-ckpt-${process.pid}-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed from HEAD when present (initial unborn repos have no HEAD yet).
    const hasHead = runGit(cwd, ["rev-parse", "--verify", "HEAD"]).ok;
    if (hasHead) {
      if (!runGit(cwd, ["read-tree", "HEAD"], env).ok) return null;
    }
    if (!runGit(cwd, ["add", "-A"], env).ok) return null;
    const write = runGit(cwd, ["write-tree"], env);
    if (!write.ok) return null;
    const sha = write.stdout.trim();
    return /^[0-9a-f]{40,}$/i.test(sha) ? sha : null;
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Persist a checkpoint record into the session JSONL file. */
export function appendSessionCheckpoint(
  sessionId: string,
  checkpoint: Omit<SessionCheckpoint, "timestamp">,
  dir: string = sessionDir(),
): void {
  const path = sessionFilePath(sessionId, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "checkpoint",
      timestamp: new Date().toISOString(),
      turn: checkpoint.turn,
      prompt: checkpoint.prompt.replace(/\s+/g, " ").slice(0, 80),
      treeSha: checkpoint.treeSha,
    })}\n`,
  );
}

/** Load all checkpoints persisted in a session JSONL file, oldest first. */
export function loadSessionCheckpoints(
  sessionId: string,
  dir: string = sessionDir(),
): SessionCheckpoint[] {
  const path = sessionFilePath(sessionId, dir);
  if (!existsSync(path)) return [];
  const out: SessionCheckpoint[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        turn?: unknown;
        prompt?: unknown;
        treeSha?: unknown;
        timestamp?: unknown;
      };
      if (
        evt.type === "checkpoint" &&
        typeof evt.turn === "number" &&
        typeof evt.treeSha === "string"
      ) {
        out.push({
          turn: evt.turn,
          prompt: typeof evt.prompt === "string" ? evt.prompt : "",
          treeSha: evt.treeSha,
          timestamp: typeof evt.timestamp === "string" ? evt.timestamp : "",
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Restore the working tree to a captured checkpoint tree SHA without touching
 *  gitignored files or modifying `.git/index`. Removes non-ignored files added
 *  after the checkpoint and checks out files from `treeSha`. */
export function restoreCheckpointTree(
  cwd: string,
  treeSha: string,
): { ok: boolean; error?: string; restoredCount: number; removedCount: number } {
  if (!isGitWorkspace(cwd)) {
    return { ok: false, error: "not a git repository", restoredCount: 0, removedCount: 0 };
  }
  const treeFilesRes = runGit(cwd, ["ls-tree", "-r", "--name-only", treeSha]);
  if (!treeFilesRes.ok) {
    return {
      ok: false,
      error: treeFilesRes.stderr.trim() || `invalid checkpoint tree ${treeSha}`,
      restoredCount: 0,
      removedCount: 0,
    };
  }
  const targetFiles = new Set(
    treeFilesRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Current tracked + untracked non-ignored files.
  const currentRes = runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (!currentRes.ok) {
    return {
      ok: false,
      error: currentRes.stderr.trim() || "failed to list workspace files",
      restoredCount: 0,
      removedCount: 0,
    };
  }
  const currentFiles = currentRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Remove files created after the checkpoint.
  let removedCount = 0;
  for (const rel of currentFiles) {
    if (!targetFiles.has(rel)) {
      try {
        rmSync(join(cwd, rel), { force: true });
        removedCount++;
      } catch {
        /* ignore */
      }
    }
  }

  // Restore file contents from `treeSha` using a temporary index so we never
  // alter the user's real staged index.
  const tmpIndex = join(tmpdir(), `oma-restore-${process.pid}-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const readTree = runGit(cwd, ["read-tree", treeSha], env);
    if (!readTree.ok) {
      return {
        ok: false,
        error: readTree.stderr.trim() || "git read-tree failed",
        restoredCount: 0,
        removedCount,
      };
    }
    const checkout = runGit(cwd, ["checkout-index", "-a", "-f"], env);
    if (!checkout.ok) {
      return {
        ok: false,
        error: checkout.stderr.trim() || "git checkout-index failed",
        restoredCount: 0,
        removedCount,
      };
    }
    return { ok: true, restoredCount: targetFiles.size, removedCount };
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Restore a single file from a checkpoint tree SHA (or delete it if absent in
 *  the checkpoint). */
export function restoreFileFromTree(
  cwd: string,
  treeSha: string,
  relPath: string,
): { ok: boolean; action?: "restored" | "removed"; error?: string } {
  if (!isGitWorkspace(cwd)) return { ok: false, error: "not a git repository" };
  const existsInTree = runGit(cwd, ["ls-tree", "--name-only", treeSha, "--", relPath]);
  if (!existsInTree.ok) {
    return { ok: false, error: existsInTree.stderr.trim() || "invalid checkpoint tree" };
  }
  if (!existsInTree.stdout.trim()) {
    try {
      rmSync(join(cwd, relPath), { force: true });
      return { ok: true, action: "removed" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const tmpIndex = join(tmpdir(), `oma-restore-one-${process.pid}-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    if (!runGit(cwd, ["read-tree", treeSha], env).ok) {
      return { ok: false, error: "git read-tree failed" };
    }
    const co = runGit(cwd, ["checkout-index", "-f", "--", relPath], env);
    if (!co.ok) return { ok: false, error: co.stderr.trim() || "git checkout-index failed" };
    return { ok: true, action: "restored" };
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Diff the live working tree against a baseline tree SHA (or HEAD when absent). */
export function diffWorkspaceAgainstTree(
  cwd: string,
  baselineTreeSha?: string,
  filePath?: string,
): { ok: boolean; stat: string; patch: string; error?: string } {
  if (!isGitWorkspace(cwd)) {
    return { ok: false, stat: "", patch: "", error: "not a git repository" };
  }
  const liveTree = captureCheckpointTree(cwd);
  if (!liveTree) {
    return { ok: false, stat: "", patch: "", error: "failed to snapshot working tree" };
  }
  const base = baselineTreeSha ?? (runGit(cwd, ["rev-parse", "--verify", "HEAD"]).ok ? "HEAD" : "");
  if (!base) {
    const status = runGit(cwd, ["status", "--short"]);
    return { ok: true, stat: status.stdout.trim(), patch: "" };
  }
  const pathArgs = filePath ? ["--", filePath] : [];
  const statRes = runGit(cwd, ["diff", "--stat", base, liveTree, ...pathArgs]);
  const patchRes = filePath
    ? runGit(cwd, ["diff", base, liveTree, "--", filePath])
    : { ok: true, stdout: "", stderr: "" };
  return {
    ok: statRes.ok && patchRes.ok,
    stat: statRes.stdout.trim(),
    patch: patchRes.stdout.trim(),
    ...(statRes.ok ? {} : { error: statRes.stderr.trim() }),
  };
}
