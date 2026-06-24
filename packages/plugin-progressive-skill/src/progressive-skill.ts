import type { Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";
import { skillLoadTool } from "./skill-load.js";

export interface ProgressiveSkillOptions {
  ws: AgentFsLike;
  /** Single root (backward compat). Use `roots` for multi-domain. */
  root?: string;
  /** Multiple roots in priority order (later overrides earlier on name collision). */
  roots?: string[];
  maxCharsPerLoad?: number;
  /** POSIX path prefix for the skill root. When set, ${SKILL_DIR} is replaced
   *  with this prefix + relative path instead of the logical path.
   *  e.g. posixSkillRoot="/var/agents/abc/private/skills", logical root="/skills/"
   *  → "${SKILL_DIR}/extract.py" becomes "/var/agents/abc/private/skills/pdf-extract/extract.py" */
  posixSkillRoot?: string;
}

export function progressiveSkillPlugin(options: ProgressiveSkillOptions): Plugin {
  const ws = options.ws;
  const roots = options.roots ?? [options.root ?? "/skills/"];
  const maxCharsPerLoad = options.maxCharsPerLoad ?? 8000;
  const posixSkillRoot = options.posixSkillRoot;

  return {
    name: "progressive-skill",
    tools: [skillLoadTool({ ws, roots, maxCharsPerLoad, posixSkillRoot })],
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        let skills: SkillMeta[];
        try {
          skills = await loadSkillIndexWithMtimeCache(ws, roots, ctx.logger);
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

        const indexBlock = renderIndex(skills.filter((s) => !s.disableModelInvocation));
        const sys = messages[systemIdx];
        if (!sys) return messages as Message[];
        const newSys = {
          ...sys,
          text: `${sys.text ?? ""}\n\n${indexBlock}`,
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
