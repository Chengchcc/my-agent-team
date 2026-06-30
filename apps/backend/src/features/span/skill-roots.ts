import { join } from "node:path";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { BUILTIN_PACK_ID } from "../skill-pack/entities.js";
import { nodeFsAdapter } from "../skill-pack/fs-adapter.js";
import type { SkillPackPort } from "../skill-pack/ports.js";

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
