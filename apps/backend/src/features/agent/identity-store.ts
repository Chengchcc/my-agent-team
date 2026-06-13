import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureRunnerWorkspace, runnerWorkspacePaths } from "../../infra/runner-workspace.js";

export interface IdentityData {
  soul: string | null;
  user: string | null;
  memories: Array<{ date: string; content: string }>;
}

export interface IdentityPatch {
  soul?: string;
  user?: string;
}

export interface AgentIdentityStore {
  getIdentity(agentId: string): Promise<IdentityData>;
  updateIdentity(agentId: string, patch: IdentityPatch): Promise<void>;
}

/** Files that are candidates for lazy migration from legacy workspace. */
const IDENTITY_FILES = [
  "SOUL.md",
  "USER.md",
  "BOOTSTRAP.md",
  "TOOLS.md",
  "AGENTS.md",
] as const;

/** Copy `src` to `dst` only if dst doesn't exist. */
async function copyIfMissing(src: string, dst: string): Promise<void> {
  try {
    await cp(src, dst, { force: false, errorOnExist: false });
  } catch {
    // src doesn't exist or other fs error — non-fatal
  }
}

/** Lazy migration: copy identity files and memory from legacy workspace
 *  to runner sharedRoot. Only copies files that don't already exist in
 *  sharedRoot — never overwrites. */
async function migrateLegacyWorkspaceToShared(sharedRoot: string, legacyWorkspacePath: string): Promise<void> {
  // Identity files
  for (const file of IDENTITY_FILES) {
    await copyIfMissing(
      path.join(legacyWorkspacePath, file),
      path.join(sharedRoot, file),
    );
  }

  // Memory directory — merge per-file so we don't overwrite
  const legacyMemDir = path.join(legacyWorkspacePath, "memory");
  const sharedMemDir = path.join(sharedRoot, "memory");
  try {
    await mkdir(sharedMemDir, { recursive: true });
    const entries = await readdir(legacyMemDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
      await copyIfMissing(
        path.join(legacyMemDir, entry),
        path.join(sharedMemDir, entry),
      );
    }
  } catch {
    // legacy memory dir doesn't exist — nothing to migrate
  }
}

async function readMemoryFacts(sharedRoot: string): Promise<Array<{ date: string; content: string }>> {
  const memories: Array<{ date: string; content: string }> = [];
  const memDir = path.join(sharedRoot, "memory");

  try {
    const entries = await readdir(memDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
      try {
        const content = await readFile(path.join(memDir, entry), "utf-8");
        const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
        memories.push({
          date: dateMatch?.[1] ?? "unknown",
          content,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Memory directory doesn't exist — leave []
  }

  return memories;
}

export function createAgentIdentityStore(opts: {
  dataDir: string;
  getAgent: (agentId: string) => Promise<{ workspacePath: string }>;
}): AgentIdentityStore {
  return {
    async getIdentity(agentId: string): Promise<IdentityData> {
      const agent = await opts.getAgent(agentId);
      const paths = runnerWorkspacePaths(opts.dataDir, agentId);
      await ensureRunnerWorkspace(paths);

      // Lazy migrate from legacy workspace (no-op if sharedRoot already has data)
      if (agent.workspacePath) {
        await migrateLegacyWorkspaceToShared(paths.sharedRoot, agent.workspacePath);
      }

      let soul: string | null = null;
      let user: string | null = null;

      try {
        soul = await readFile(path.join(paths.sharedRoot, "SOUL.md"), "utf-8");
      } catch { /* leave null */ }

      try {
        user = await readFile(path.join(paths.sharedRoot, "USER.md"), "utf-8");
      } catch { /* leave null */ }

      const memories = await readMemoryFacts(paths.sharedRoot);

      return { soul, user, memories };
    },

    async updateIdentity(agentId: string, patch: IdentityPatch): Promise<void> {
      const agent = await opts.getAgent(agentId);
      const paths = runnerWorkspacePaths(opts.dataDir, agentId);
      await ensureRunnerWorkspace(paths);

      if (agent.workspacePath) {
        await migrateLegacyWorkspaceToShared(paths.sharedRoot, agent.workspacePath);
      }

      if (typeof patch.soul === "string") {
        await writeFile(path.join(paths.sharedRoot, "SOUL.md"), patch.soul, "utf-8");
      }
      if (typeof patch.user === "string") {
        await writeFile(path.join(paths.sharedRoot, "USER.md"), patch.user, "utf-8");
      }
    },
  };
}
