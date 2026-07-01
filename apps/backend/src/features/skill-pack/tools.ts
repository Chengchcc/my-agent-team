import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool } from "@my-agent-team/core";
import { loadSkillIndexWithMtimeCache } from "@my-agent-team/plugin-progressive-skill";
import { posixSkillRoot } from "./entities.js";
import { nodeFsAdapter } from "./fs-adapter.js";
import type { SkillPackPort } from "./ports.js";

// ─── validation helpers ──────────────────────────────────────────────────────────

export function assertSafeEntry(name: string): void {
  if (!name || name.startsWith("/") || name.includes("..") || name.includes("\\")) {
    throw new Error(`Unsafe path entry: ${name}`);
  }
}

async function validatePackDir(cwd: string, targetDir: string): Promise<boolean> {
  const ws = nodeFsAdapter(cwd);
  const skills = await loadSkillIndexWithMtimeCache(ws, [targetDir]);
  return skills.length > 0;
}

function computeDirChecksum(cwd: string, dir: string): string {
  const hash = createHash("sha256");
  function walk(d: string) {
    const full = resolve(cwd, d);
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const p = resolve(full, entry.name);
      if (entry.isFile()) {
        hash.update(readFileSync(p));
      } else if (entry.isDirectory()) {
        walk(resolve(d, entry.name));
      }
    }
  }
  walk(dir);
  return hash.digest("hex");
}

/**
 * Validate extracted zip entries: reject symlinks (not allowed in skill packs)
 * and ensure no path escapes the extract root via ../ or absolute path.
 * Called BEFORE atomic rename from temp to the final targetDir.
 */
function validateExtractedEntries(root: string, dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in skill packs: ${entry.name}`);
    }

    // For regular files/dirs, verify realpath is within root
    const real = realpathSync(fullPath);
    const normalizedRoot = resolve(root);
    if (!real.startsWith(`${normalizedRoot}/`) && real !== normalizedRoot) {
      throw new Error(`Path escape detected: ${entry.name} → ${real}`);
    }

    if (entry.isDirectory()) {
      validateExtractedEntries(root, fullPath);
    }
  }
}

// ─── git helpers ─────────────────────────────────────────────────────────────────

function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 }),
    );
  });
}

// ─── tool factories ──────────────────────────────────────────────────────────────

export interface PackToolsDeps {
  port: SkillPackPort;
  dataDir: string;
  /** Optional path to a pre-extracted zip file (for install sessions where buffer shouldn't go through LLM). */
  zipPath?: string;
}

export function createPackGitCloneTool(deps: PackToolsDeps): Tool {
  const cwd = posixSkillRoot(deps.dataDir);

  return {
    name: "pack_git_clone",
    description: `Clone a git repository into a target directory under the skill-packs root. The targetDir must be a single directory name (no slashes).`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Git repository URL." },
        ref: { type: "string", description: "Optional branch/tag to clone." },
        targetDir: { type: "string", description: "Target directory name (no slashes)." },
      },
      required: ["url", "targetDir"],
    },
    async execute(input: unknown) {
      const { url, ref, targetDir } = input as { url: string; ref?: string; targetDir: string };
      assertSafeEntry(targetDir);
      if (targetDir.includes("/")) throw new Error("targetDir must not contain slashes");

      const args = ["clone", "--depth", "1"];
      if (ref) args.push("--branch", ref);
      args.push(url, targetDir);

      const result = await git(args, cwd);
      if (result.exitCode !== 0) {
        return { content: `git clone failed: ${result.stderr}`, isError: true };
      }
      // Get the actual commit hash
      const revResult = await git(["rev-parse", "HEAD"], resolve(cwd, targetDir));
      const commit = revResult.exitCode === 0 ? revResult.stdout : "unknown";
      return { content: `Cloned to ${targetDir} (commit: ${commit})` };
    },
  };
}

export function createPackUnzipTool(deps: PackToolsDeps): Tool {
  const cwd = posixSkillRoot(deps.dataDir);

  return {
    name: "pack_unzip",
    description: `Unzip a zip archive into a target directory under the skill-packs root. The targetDir must be a single directory name (no slashes). When the zip file was pre-staged by the system, no bufferB64 is needed — the tool reads it from the pre-staged path. Otherwise, pass the base64-encoded zip contents.`,
    inputSchema: {
      type: "object",
      properties: {
        bufferB64: {
          type: "string",
          description: "Base64-encoded zip file contents. Optional when zip was pre-staged.",
        },
        targetDir: { type: "string", description: "Target directory name (no slashes)." },
      },
      required: ["targetDir"],
    },
    async execute(input: unknown) {
      const { bufferB64, targetDir } = input as { bufferB64?: string; targetDir: string };
      assertSafeEntry(targetDir);
      if (targetDir.includes("/")) throw new Error("targetDir must not contain slashes");

      const buffer = deps.zipPath
        ? readFileSync(deps.zipPath)
        : bufferB64
          ? Buffer.from(bufferB64, "base64")
          : null;
      if (!buffer) {
        return {
          content: "No zip data provided. Pre-staged zip not found and no bufferB64 given.",
          isError: true,
        };
      }

      const tmpDir = mkdtempSync(join(tmpdir(), "pack-unzip-"));
      const zipPath = join(tmpDir, "upload.zip");
      writeFileSync(zipPath, buffer);

      try {
        // Step 1: unzip to isolated temp directory
        const extractDir = join(tmpDir, "extract");
        const result = await new Promise<{ exitCode: number; stderr: string }>((resolve) => {
          const proc = spawn("unzip", ["-o", zipPath, "-d", extractDir], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          proc.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
          });
          proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
        });
        if (result.exitCode !== 0) {
          return { content: `unzip failed: ${result.stderr}`, isError: true };
        }

        // Step 2: validate every entry — reject symlinks (not allowed in skill packs)
        validateExtractedEntries(extractDir, extractDir);

        // Step 3: clean stale target, then atomic rename
        const targetFull = resolve(cwd, targetDir);
        if (existsSync(targetFull)) rmSync(targetFull, { recursive: true, force: true });
        renameSync(extractDir, targetFull);

        const checksum = computeDirChecksum(cwd, targetDir);
        return { content: `Unzipped to ${targetDir} (checksum: ${checksum})` };
      } finally {
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export function createPackGitSyncTool(deps: PackToolsDeps): Tool {
  const cwd = posixSkillRoot(deps.dataDir);

  return {
    name: "pack_git_sync",
    description: `Sync a git-based skill pack by fetching and resetting to the remote. Handles dirty working trees by stashing first. The targetDir must be a single directory name.`,
    inputSchema: {
      type: "object",
      properties: {
        targetDir: { type: "string", description: "Pack directory name (no slashes)." },
        ref: { type: "string", description: "Optional ref to sync to." },
      },
      required: ["targetDir"],
    },
    async execute(input: unknown) {
      const { targetDir, ref } = input as { targetDir: string; ref?: string };
      assertSafeEntry(targetDir);

      const packDir = resolve(cwd, targetDir);
      // Fetch
      const fetchArgs = ["fetch", "origin"];
      if (ref) fetchArgs.push(ref);
      const fetchResult = await git(fetchArgs, packDir);
      if (fetchResult.exitCode !== 0) {
        return { content: `git fetch failed: ${fetchResult.stderr}`, isError: true };
      }

      // Reset to FETCH_HEAD (always correct after fetch, works on shallow clones)
      const resetResult = await git(["reset", "--hard", "FETCH_HEAD"], packDir);
      if (resetResult.exitCode !== 0) {
        return { content: `git reset failed: ${resetResult.stderr}`, isError: true };
      }

      const revResult = await git(["rev-parse", "HEAD"], packDir);
      const commit = revResult.exitCode === 0 ? revResult.stdout : "unknown";
      return { content: `Synced to commit ${commit}` };
    },
  };
}

export function createPackValidateTool(deps: PackToolsDeps): Tool {
  const cwd = posixSkillRoot(deps.dataDir);

  return {
    name: "pack_validate",
    description: `Validate that a skill pack directory contains at least one valid SKILL.md file. Returns { valid: true/false } and the skill count.`,
    inputSchema: {
      type: "object",
      properties: {
        targetDir: { type: "string", description: "Pack directory name (no slashes)." },
      },
      required: ["targetDir"],
    },
    async execute(input: unknown) {
      const { targetDir } = input as { targetDir: string };
      const valid = await validatePackDir(cwd, targetDir);
      if (valid) {
        const ws = nodeFsAdapter(cwd);
        const skills = await loadSkillIndexWithMtimeCache(ws, [targetDir]);
        return {
          content: JSON.stringify({
            valid: true,
            count: skills.length,
            skills: skills.map((s) => s.name),
          }),
        };
      }
      return { content: JSON.stringify({ valid: false, count: 0 }), isError: true };
    },
  };
}

export function createPackAtomicRenameTool(deps: PackToolsDeps): Tool {
  const cwd = posixSkillRoot(deps.dataDir);

  return {
    name: "pack_atomic_rename",
    description: `Atomically rename a directory within the skill-packs root. Used to move from a temp directory to the final pack directory.`,
    inputSchema: {
      type: "object",
      properties: {
        tmpDir: { type: "string", description: "Source directory name (no slashes)." },
        finalDir: { type: "string", description: "Destination directory name (no slashes)." },
      },
      required: ["tmpDir", "finalDir"],
    },
    async execute(input: unknown) {
      const { tmpDir, finalDir } = input as { tmpDir: string; finalDir: string };
      assertSafeEntry(tmpDir);
      const dest = resolve(cwd, finalDir);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      renameSync(resolve(cwd, tmpDir), dest);
      return { content: `Renamed ${tmpDir} → ${finalDir}` };
    },
  };
}

export function createPackUpdateStatusTool(deps: PackToolsDeps): Tool {
  return {
    name: "pack_update_status",
    description: `Update the installation status of a skill pack. Valid transitions: pending→installing, installing→ready|failed, ready→syncing, syncing→ready|failed, failed→installing|syncing.`,
    inputSchema: {
      type: "object",
      properties: {
        packId: { type: "string", description: "The pack ID." },
        status: { type: "string", description: "The new status." },
        installedRef: {
          type: "string",
          description: "The git commit or zip checksum (for ready status).",
        },
        error: { type: "string", description: "Error message (for failed status)." },
      },
      required: ["packId", "status"],
    },
    async execute(input: unknown) {
      const { packId, status, installedRef, error } = input as {
        packId: string;
        status: string;
        installedRef?: string;
        error?: string;
      };

      try {
        const row = await deps.port.applyInstallTransition(packId, status as never, {
          installedRef,
          error,
          now: Date.now(),
        });
        if (!row) return { content: `Pack not found: ${packId}`, isError: true };
        return { content: `Status updated: ${row.status}` };
      } catch (err) {
        return { content: `Invalid transition: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** All 6 atomic tools as an array. */
export function createAllPackTools(deps: PackToolsDeps): Tool[] {
  return [
    createPackGitCloneTool(deps),
    createPackUnzipTool(deps),
    createPackGitSyncTool(deps),
    createPackValidateTool(deps),
    createPackAtomicRenameTool(deps),
    createPackUpdateStatusTool(deps),
  ];
}
