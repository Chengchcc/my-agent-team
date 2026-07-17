import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";

export function skillLoadTool(opts: {
  ws: AgentFsLike;
  roots: string[];
  /** POSIX path prefix for the skill root (see ProgressiveSkillOptions.posixSkillRoot). */
  posixSkillRoot?: string;
}): Tool {
  const { ws, roots, posixSkillRoot } = opts;

  async function findSkill(name: string): Promise<SkillMeta | null> {
    const skills = await loadSkillIndexWithMtimeCache(ws, roots);
    return skills.find((s) => s.name === name) ?? null;
  }

  /** Find which root a skill dir belongs to by prefix match.
   *  Returns the last (highest-priority) matching root. */
  function findMatchingRoot(skillDir: string): string {
    let best = "";
    for (const r of roots) {
      const normalised = r.replace(/\/$/, "");
      if (skillDir.startsWith(`${normalised}/`) || skillDir === normalised) {
        best = normalised;
      }
    }
    return best;
  }

  /** Resolve ${SKILL_DIR} to a path bash/grep can actually use.
   *  If posixSkillRoot is set, map the matching logical root -> POSIX root.
   *  Otherwise fall back to the logical path (read/write/edit still work). */
  function resolveSkillDir(logicalDir: string): string {
    if (posixSkillRoot) {
      const posixRoot = posixSkillRoot.endsWith("/") ? posixSkillRoot.slice(0, -1) : posixSkillRoot;
      const matchingRoot = findMatchingRoot(logicalDir);
      if (matchingRoot) {
        return logicalDir.replace(matchingRoot, posixRoot);
      }
    }
    return logicalDir;
  }

  return {
    name: "skill",
    description:
      "Load a skill's full instructions. When a user query matches a skill, use this tool to load it. " +
      "Prefer this over read for loading skill instructions. Returns the skill body (frontmatter excluded).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name to load (from available-skills)." },
      },
      required: ["name"],
    },
    async execute(input: unknown) {
      const { name } = input as { name: string };

      const skill = await findSkill(name);
      if (!skill) return { content: `Skill not found: ${name}`, isError: true };

      const raw = (await ws.read(skill.skillMdPath)) ?? "";
      // bodyOffset strips frontmatter -- model gets clean instructions only.
      // frontmatter (name/description) is already in <available-skills> in the meta message.
      const body = raw.slice(skill.bodyOffset);
      const resolved = body.replaceAll("${SKILL_DIR}", resolveSkillDir(skill.dir));

      const prefix = `Base directory for this skill: ${resolveSkillDir(skill.dir)}\n\n`;
      return { content: prefix + resolved.trim() };
    },
  };
}
