import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureRunnerWorkspace,
  migrateLegacyWorkspaceToShared,
  runnerWorkspacePaths,
} from "../../infra/runner-workspace.js";

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

function isCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}

/** Read a text file; return null when the file doesn't exist. */
async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    throw err;
  }
}

/** Read memory facts from the runner sharedRoot.
 *
 *  Layout (M14.7 post-fix):
 *    shared/memory/MEMORY.md          — summary / dated memory
 *    shared/memory/facts/*.md         — agent-written facts
 *
 *  Also reads flat shared/memory/*.md for backward compat (legacy agents). */
async function readMemoryFacts(sharedRoot: string): Promise<Array<{ date: string; content: string }>> {
  const memories: Array<{ date: string; content: string }> = [];
  const memoryRoot = path.join(sharedRoot, "memory");

  // 1) MEMORY.md — dated summary
  const summary = await readTextOrNull(path.join(memoryRoot, "MEMORY.md"));
  if (summary?.trim()) {
    memories.push({ date: "summary", content: summary });
  }

  // 2) memory/facts/*.md — agent-written facts
  const factsDir = path.join(memoryRoot, "facts");
  try {
    const entries = await readdir(factsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
      const content = await readTextOrNull(path.join(factsDir, entry));
      if (content?.trim()) {
        const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
        memories.push({ date: dateMatch?.[1] ?? "fact", content });
      }
    }
  } catch (err) {
    if (!isCode(err, "ENOENT")) throw err;
  }

  // 3) Flat shared/memory/*.md (legacy compat) — skip MEMORY.md
  try {
    const entries = await readdir(memoryRoot);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry === "MEMORY.md") continue;
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
      // Skip if also exists in facts/ (dedup)
      try {
        await readFile(path.join(factsDir, entry), "utf-8");
        continue; // already read in step 2
      } catch {
        // not in facts — read from flat
      }
      const content = await readTextOrNull(path.join(memoryRoot, entry));
      if (content?.trim()) {
        const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
        memories.push({ date: dateMatch?.[1] ?? "legacy", content });
      }
    }
  } catch (err) {
    if (!isCode(err, "ENOENT")) throw err;
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

      const [soul, user, memories] = await Promise.all([
        readTextOrNull(path.join(paths.sharedRoot, "SOUL.md")),
        readTextOrNull(path.join(paths.sharedRoot, "USER.md")),
        readMemoryFacts(paths.sharedRoot),
      ]);

      return { soul, user, memories };
    },

    async updateIdentity(agentId: string, patch: IdentityPatch): Promise<void> {
      const agent = await opts.getAgent(agentId);
      const paths = runnerWorkspacePaths(opts.dataDir, agentId);
      await ensureRunnerWorkspace(paths);

      if (agent.workspacePath) {
        await migrateLegacyWorkspaceToShared(paths.sharedRoot, agent.workspacePath);
      }

      // Ensure memory/facts/ directory exists so the agent can write
      await mkdir(path.join(paths.sharedRoot, "memory", "facts"), { recursive: true });

      if (typeof patch.soul === "string") {
        await writeFile(path.join(paths.sharedRoot, "SOUL.md"), patch.soul, "utf-8");
      }
      if (typeof patch.user === "string") {
        await writeFile(path.join(paths.sharedRoot, "USER.md"), patch.user, "utf-8");
      }
    },
  };
}
