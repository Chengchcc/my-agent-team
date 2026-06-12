import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";
import { truncateAtParagraph } from "./truncation.js";

export function skillLoadTool(opts: {
  ws: AgentFsLike;
  root: string;
  maxCharsPerLoad?: number;
}): Tool {
  const { ws, root, maxCharsPerLoad = 8000 } = opts;
  const lookahead = 500;

  async function findSkill(name: string): Promise<SkillMeta | null> {
    const skills = await loadSkillIndexWithMtimeCache(ws, root);
    return skills.find((s) => s.name === name) ?? null;
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
      // M14.7 AFS: `${SKILL_DIR}` replaced with logical path (e.g. /skills/my-skill).
      // For bash reachability, the /skills/ mount must have a posixRoot configured.
      const resolved = body.replaceAll("${SKILL_DIR}", skill.dir);

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
