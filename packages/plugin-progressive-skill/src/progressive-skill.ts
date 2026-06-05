import type { Message } from "@my-agent-team/core";
import type { Plugin } from "@my-agent-team/framework";
import { stat } from "node:fs/promises";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";
import { skillLoadTool } from "./skill-load.js";

export interface ProgressiveSkillOptions {
  dir: string;
  maxCharsPerLoad?: number;
}

export function progressiveSkillPlugin(options: ProgressiveSkillOptions): Plugin {
  const dir = options.dir;
  const maxCharsPerLoad = options.maxCharsPerLoad ?? 8000;

  let dirExists = false;

  return {
    name: "progressive-skill",
    tools: [skillLoadTool({ dir, maxCharsPerLoad })],
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        // Check dir existence (only once — dir can't appear mid-session)
        if (!dirExists) {
          try {
            await stat(dir);
            dirExists = true;
          } catch {
            ctx.logger.warn("progressive-skill: dir not found, skipping injection");
            return [...messages];
          }
        }

        let skills: SkillMeta[];
        try {
          skills = await loadSkillIndexWithMtimeCache(dir, ctx.logger);
        } catch (err) {
          ctx.logger.warn("progressive-skill: load failed, skipping injection", err);
          return [...messages];
        }

        if (skills.length === 0) return [...messages];

        const systemIdx = messages.findIndex((m) => m.role === "system");
        if (systemIdx < 0) {
          ctx.logger.warn("progressive-skill: no system message, skipping injection");
          return [...messages];
        }

        const indexBlock = renderIndex(skills);
        const sys = messages[systemIdx]!;
        const newSys = {
          ...sys,
          content: `${sys.content}\n\n${indexBlock}`,
        };
        return [
          ...messages.slice(0, systemIdx),
          newSys,
          ...messages.slice(systemIdx + 1),
        ] as Message[];
      },
    },
  };
}

function renderIndex(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);
  return `<available-skills>
${lines.join("\n")}

Call \`skill_load(name)\` to load the full instructions for a skill before using it.
</available-skills>`;
}
