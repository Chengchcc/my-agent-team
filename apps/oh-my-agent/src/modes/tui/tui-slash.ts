import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand } from "@chengchenccc/tui";
import { resolveStandaloneSkillRoots } from "../../cli/initial-input.js";
import { buildSkillIndex } from "../../core/tools/index.js";
import type { CommandDef, TuiSessionContext } from "./tui-commands.js";
import { sessionRow } from "./tui-format.js";

export interface SlashSystem {
  commandsWithSkills: CommandDef[];
  slashCommands: SlashCommand[];
  runCommandText: (text: string) => Promise<void>;
}

/** Auto-registered skill commands (pi's /skill:<name> pattern): every
 *  discovered skill becomes a slash command that submits a prompt pointing
 *  the model at the skill. */
export function buildSlashSystem(ctx: TuiSessionContext, commands: CommandDef[]): SlashSystem {
  const skillCommands: readonly CommandDef[] = buildSkillIndex(
    resolveStandaloneSkillRoots(ctx.opts.workspaceRoot),
  ).map((sk) => ({
    name: `skill:${sk.name}`,
    description: sk.description || `invoke the ${sk.name} skill`,
    group: "skill",
    run: (args: string) => {
      ctx.pendingPrompt = args
        ? `${args}\n\n(follow the "${sk.name}" skill — skill_load "${sk.name}" first)`
        : `Follow the "${sk.name}" skill (skill_load "${sk.name}" first).`;
    },
  }));
  const commandsWithSkills = [...commands, ...skillCommands];
  ctx.commandsWithSkills = commandsWithSkills;

  // Autocomplete: the editor already triggers on "/" — hand it the visible
  // command table (static commands + auto-registered skill commands). Hidden
  // legacy commands stay callable in runCommandText without cluttering menus.
  const slashCommands: SlashCommand[] = commandsWithSkills
    .filter((c) => !c.hidden)
    .map((c) => {
      const command: SlashCommand = { name: c.name, description: c.description };
      if (c.argumentHint) command.argumentHint = c.argumentHint;
      if (c.name === "model") {
        command.getArgumentCompletions = async (prefix: string) => {
          const models = await ctx.listModels();
          return models.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m }));
        };
      }
      if (c.name === "resume") {
        command.getArgumentCompletions = (prefix: string) =>
          ctx
            .listSessions()
            .filter((s) => s.id.startsWith(prefix))
            .slice(0, 20)
            .map((s) => ({
              value: s.id,
              label: s.id,
              // Same row description as the picker/listing (title — summary).
              description: sessionRow(s, undefined, {
                currentWorkspace: ctx.opts.workspaceRoot,
              }).description,
            }));
      }
      if (c.name === "orchestrate") {
        command.getArgumentCompletions = (prefix: string) => {
          const names = new Set<string>();
          for (const folder of ["orchestrations", "workflow"]) {
            const dir = join(ctx.opts.workspaceRoot, ".oma", folder);
            if (!existsSync(dir)) continue;
            try {
              for (const entry of readdirSync(dir)) {
                if (entry.endsWith(".js")) names.add(entry.slice(0, -3));
              }
            } catch {
              /* ignore */
            }
          }
          return [...names]
            .sort()
            .filter((name) => name.startsWith(prefix))
            .slice(0, 20)
            .map((name) => ({
              value: name,
              label: name,
              description: `.oma/orchestrations/${name}.js`,
            }));
        };
      }
      return command;
    });

  /** Slash-command dispatch shared by the idle loop and live submissions
   *  (pi's LiveCommandController: /commands execute even mid-run instead of
   *  being steered into the model as literal text). */
  async function runCommandText(text: string): Promise<void> {
    const space = text.indexOf(" ");
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    const args = space === -1 ? "" : text.slice(space + 1).trim();
    const command =
      commandsWithSkills.find((c) => c.name === name) ??
      commandsWithSkills.find((c) => c.aliases?.includes(name));
    if (!command) {
      ctx.pushStatus(`unknown command /${name} — try /help`);
      return;
    }
    if (ctx.liveRuntime && !command.live) {
      ctx.pushStatus(`/${name} is not available while a run is live`);
      return;
    }
    await command.run(args);
  }

  return { commandsWithSkills, slashCommands, runCommandText };
}
