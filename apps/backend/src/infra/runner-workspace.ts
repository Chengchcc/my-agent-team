import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface RunnerWorkspacePaths {
  runnerRoot: string;
  sharedRoot: string;
  privateRoot: string;
  stateRoot: string;
  socketPath: string;
  pidFile: string;
}

/** Sanitize an agentId for use in filesystem paths. Current agentId
 *  format is ULID (alphanumeric), so this is a no-op in practice.
 *  Throws on characters that would cause path collisions (e.g. '/'
 *  could map two different IDs to the same sanitized name). */
export function safeRunnerAgentId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      `invalid runner agentId: "${id}" — contains characters outside [a-zA-Z0-9_-]`,
    );
  }
  return id;
}

/** Single source of truth for all runner directory layout. */
export function runnerWorkspacePaths(
  dataDir: string,
  agentId: string,
): RunnerWorkspacePaths {
  const runnerRoot = path.join(dataDir, "runners", safeRunnerAgentId(agentId));
  return {
    runnerRoot,
    sharedRoot: path.join(runnerRoot, "shared"),
    privateRoot: path.join(runnerRoot, "private"),
    stateRoot: path.join(runnerRoot, "state"),
    socketPath: path.join(runnerRoot, "runner.sock"),
    pidFile: path.join(runnerRoot, "runner.pid"),
  };
}

/** Ensure the three sub-roots exist. Idempotent. */
export async function ensureRunnerWorkspace(
  paths: RunnerWorkspacePaths,
): Promise<void> {
  await mkdir(paths.sharedRoot, { recursive: true });
  await mkdir(paths.privateRoot, { recursive: true });
  await mkdir(paths.stateRoot, { recursive: true });
}

// ─── Error helpers ──────────────────────────────────────────────

function isCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}

/** Copy src→dst only if dst doesn't already exist. Creates the
 *  destination parent directory first, so the remaining ENOENT from
 *  cp() reliably means "source doesn't exist" — never "parent missing". */
async function copyIfMissing(src: string, dst: string): Promise<void> {
  try {
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { force: false, errorOnExist: true });
  } catch (err) {
    if (isCode(err, "ENOENT") || isCode(err, "EEXIST")) return;
    if (
      err instanceof Error &&
      (err.message.includes("already exists") ||
        err.message.includes("EEXIST"))
    )
      return;
    throw err;
  }
}

/** Read directory entries, returning [] on ENOENT. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isCode(err, "ENOENT")) return [];
    throw err;
  }
}

/** Copy all .md files from srcDir to dstDir, skipping paths with traversal
 *  characters. Missing srcDir (ENOENT) is silently skipped. */
async function copyDirFilesIfMissing(
  srcDir: string,
  dstDir: string,
): Promise<void> {
  await mkdir(dstDir, { recursive: true });
  const entries = await safeReaddir(srcDir);
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry.includes("..") || entry.includes("/") || entry.includes("\\"))
      continue;
    await copyIfMissing(path.join(srcDir, entry), path.join(dstDir, entry));
  }
}

// ─── Legacy migration ───────────────────────────────────────────

/** Files that are candidates for migration from legacy workspace. */
const IDENTITY_FILES = [
  "SOUL.md",
  "USER.md",
  "BOOTSTRAP.md",
  "TOOLS.md",
  "AGENTS.md",
] as const;

/**
 * Migrate identity files and memory from legacy workspace to runner
 * sharedRoot. Only copies files that don't already exist in sharedRoot —
 * never overwrites. Memory routing:
 *
 *   legacy/memory/MEMORY.md       → shared/memory/MEMORY.md
 *   legacy/memory/facts/*.md      → shared/memory/facts/*.md
 *   legacy/memory/*.md (flat)     → shared/memory/facts/*.md
 *
 * Idempotent and safe to call at any time (create, identity read, etc.).
 */
export async function migrateLegacyWorkspaceToShared(
  sharedRoot: string,
  legacyWorkspacePath: string,
): Promise<void> {
  // Identity files (SOUL.md, USER.md, BOOTSTRAP.md, etc.)
  for (const file of IDENTITY_FILES) {
    await copyIfMissing(
      path.join(legacyWorkspacePath, file),
      path.join(sharedRoot, file),
    );
  }

  // Memory — create target dirs first so copyIfMissing's mkdir doesn't
  // need to race, and MEMORY.md can land in a dir that exists.
  const legacyMemDir = path.join(legacyWorkspacePath, "memory");
  const sharedMemDir = path.join(sharedRoot, "memory");
  const sharedFactsDir = path.join(sharedMemDir, "facts");
  await mkdir(sharedMemDir, { recursive: true });
  await mkdir(sharedFactsDir, { recursive: true });

  // MEMORY.md → shared/memory/MEMORY.md
  await copyIfMissing(
    path.join(legacyMemDir, "MEMORY.md"),
    path.join(sharedMemDir, "MEMORY.md"),
  );

  // legacy/memory/facts/*.md → shared/memory/facts/*.md
  await copyDirFilesIfMissing(
    path.join(legacyMemDir, "facts"),
    sharedFactsDir,
  );

  // legacy flat .md files (except MEMORY.md) → shared/memory/facts/
  const legacyEntries = await safeReaddir(legacyMemDir);
  for (const entry of legacyEntries) {
    if (entry === "MEMORY.md") continue;
    if (!entry.endsWith(".md")) continue;
    if (entry.includes("..") || entry.includes("/") || entry.includes("\\"))
      continue;
    await copyIfMissing(
      path.join(legacyMemDir, entry),
      path.join(sharedFactsDir, entry),
    );
  }
}

// ─── Purge ──────────────────────────────────────────────────────

/**
 * Physically remove a runner's entire workspace directory. Used during
 * hardDelete so no runner data (shared, private, state, socket, pid)
 * is left behind. Idempotent (ENOENT = no-op).
 *
 * Rejects:
 *  - empty or invalid agentId
 *  - paths that resolve to the runners root itself
 *  - paths that escape the runners root
 */
export async function purgeRunnerWorkspace(opts: {
  dataDir: string;
  agentId: string;
}): Promise<void> {
  const safeId = safeRunnerAgentId(opts.agentId);
  if (!safeId) throw new Error(`invalid agentId: "${opts.agentId}"`);

  const runnersRoot = path.resolve(opts.dataDir, "runners");
  const runnerRoot = path.resolve(runnersRoot, safeId);

  // Must be a strict subdirectory of runnersRoot — never runnersRoot itself
  if (
    runnerRoot === runnersRoot ||
    !runnerRoot.startsWith(runnersRoot + path.sep)
  ) {
    throw new Error(`path traversal rejected: ${opts.agentId}`);
  }

  await rm(runnerRoot, { recursive: true, force: true });
}
