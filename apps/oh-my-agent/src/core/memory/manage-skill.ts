import type { PluginTool } from "../index.js";
import {
  deleteManagedSkill,
  isClaimedByAuthoredSkill,
  parseSkillArg,
  writeManagedSkill,
} from "./managed-skills.js";

/** Direct create/update/delete of isolated managed skills (omp manage_skill).
 *  Unlike `learn`, mutations refresh the LIVE session's skill index, so the
 *  new/updated skill is loadable via skill_load in the same run. */
export function createManageSkillTool(opts: {
  skillRoots: readonly string[];
  /** Re-scan the session's skill roots after a mutation (hot refresh). */
  refreshSkills: () => void;
}): PluginTool {
  return {
    name: "manage_skill",
    description:
      "Create, update, or delete an isolated managed skill (SKILL.md under " +
      "<agentDir>/managed-skills, surfaced as a normal skill). For repeatable " +
      "procedures worth codifying — setup sequences, debugging recipes, " +
      "project-specific workflows. Managed skills are the ONLY skills this can " +
      "touch; user-authored skill dirs are never modified. The active session's " +
      "skill index refreshes immediately after every successful mutation.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"] },
        name: { type: "string", description: "kebab-case skill name" },
        description: {
          type: "string",
          description: "one-line when-to-use (required for create/update)",
        },
        body: {
          type: "string",
          description: "the SKILL.md body in markdown, no frontmatter (required for create/update)",
        },
      },
      required: ["action", "name"],
    },
    async execute(args) {
      const action =
        args.action === "delete" || args.action === "update" || args.action === "create"
          ? args.action
          : null;
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!action || !name) {
        return { error: "action (create|update|delete) and name are required", isError: true };
      }
      try {
        if (action === "delete") {
          deleteManagedSkill(name);
          opts.refreshSkills();
          return { deleted: name };
        }
        const skill = parseSkillArg({
          action,
          name,
          description: args.description,
          body: args.body,
        });
        if (!skill) {
          return { error: `"${action}" needs both a description and a body`, isError: true };
        }
        if (action === "create" && isClaimedByAuthoredSkill(name, opts.skillRoots)) {
          return {
            error: `an authored skill named "${name}" already exists; managed skills cannot override it — choose a different name`,
            isError: true,
          };
        }
        const { path } = writeManagedSkill(skill);
        opts.refreshSkills();
        return { action, name, path };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
