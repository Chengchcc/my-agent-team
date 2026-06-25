import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";
import { truncateAtParagraph } from "./truncation.js";

export function skillLoadTool(opts: {
  ws: AgentFsLike;
  roots: string[];
  maxCharsPerLoad?: number;
  /** POSIX path prefix for the skill root (see ProgressiveSkillOptions.posixSkillRoot). */
  posixSkillRoot?: string;
}): Tool {
  const { ws, roots, maxCharsPerLoad = 8000, posixSkillRoot } = opts;
  const lookahead = 500;

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
   *  If posixSkillRoot is set, map the matching logical root → POSIX root.
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
    name: "skill_load",
    description: "Load the full instructions for an available skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name to load." },
        offset: { type: "number", description: "Offset to continue reading from." },
      },
      required: ["name"],
    },
    async execute(input: unknown) {
      const { name, offset = 0 } = input as { name: string; offset?: number };

      const skill = await findSkill(name);
      if (!skill) return { content: `Skill not found: ${name}`, isError: true };

      const raw = (await ws.read(skill.skillMdPath)) ?? "";
      const body = raw.slice(skill.bodyOffset);
      const resolved = body.replaceAll("${SKILL_DIR}", resolveSkillDir(skill.dir));

      if (offset >= resolved.length) {
        return { content: `Skill ${name} fully loaded.` };
      }

      const remainder = resolved.slice(offset);
      const result = truncateAtParagraph(remainder, maxCharsPerLoad, lookahead);

      const suffix =
        result.nextOffset !== undefined
          ? `\n\n[Truncated. Call skill_load('${name}', offset=${offset + result.nextOffset}) to continue.]`
          : "";

      return { content: result.content + suffix };
    },
  };
}
