import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { BUILTIN_PACK_ID } from "../skill-pack/entities.js";
import type { SkillPackPort } from "../skill-pack/ports.js";

// ─── Shared FS adapter ────────────────────────────────────────────────────────────

function nodeFsAdapter(cwd: string): AgentFsLike {
  return {
    async read(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(dir: string) {
      try {
        const full = resolve(cwd, dir);
        if (!full.startsWith(cwd)) return [];
        return readdirSync(full, { withFileTypes: true }).map((d) => d.name);
      } catch {
        return [];
      }
    },
    async stat(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(path: string) {
      try {
        const full = resolve(cwd, path);
        return full.startsWith(cwd) && existsSync(full);
      } catch {
        return false;
      }
    },
    async mkdirp(path: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
    },
  };
}

// ─── Build skill roots ────────────────────────────────────────────────────────────

export interface SkillRoots {
  ws: AgentFsLike;
  roots: string[];
  posixSkillRoot: string;
}

/**
 * Build progressive-skill plugin options from an agent's assigned packs.
 * - ws: shared fs adapter rooted at <dataDir>/skill-packs/
 * - roots: pack IDs in order (builtin first, then user packs)
 * - posixSkillRoot: absolute path for ${SKILL_DIR} resolution
 */
export async function buildSkillRoots(
  agentId: string,
  skillPackPort: SkillPackPort,
  dataDir: string,
): Promise<SkillRoots> {
  const sharedRoot = join(dataDir, "skill-packs");
  const ws = nodeFsAdapter(sharedRoot);

  const packs = await skillPackPort.listForAgent(agentId);
  const readyPacks = packs.filter((p) => p.status === "ready");

  // Builtin always first, then user packs
  const builtin = readyPacks.find((p) => p.sourceKind === "builtin");
  const others = readyPacks.filter((p) => p.sourceKind !== "builtin");

  const roots = [builtin?.id ?? BUILTIN_PACK_ID, ...others.map((p) => p.id)].filter(Boolean);

  return { ws, roots, posixSkillRoot: sharedRoot };
}
