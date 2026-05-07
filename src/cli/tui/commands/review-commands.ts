import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';
import { useTuiStore } from '../state/store';

const AUTO_SKILLS_DIR = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
const PERCENTAGE_BASE = 100;

/**
 * Handle /review command — manage auto-generated skills.
 * Sub-commands: list, view <name>, keep <name>, delete <name>.
 */
async function handleReview(ctx: CommandHandlerContext): Promise<void> {
  const { onOutput, args } = ctx;
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? 'list';
  const skillName = parts[1];

  try {
    switch (sub) {
      case 'list': {
        let entries;
        try {
          entries = await fs.readdir(AUTO_SKILLS_DIR, { withFileTypes: true });
        } catch {
          onOutput('No auto-generated skills found.');
          return;
        }
        const skills = entries.filter(e => e.isDirectory()).map(e => e.name);
        if (skills.length === 0) {
          onOutput('No auto skills.');
          return;
        }
        const lines = ['Auto skills:'];
        for (const name of skills) {
          let info = `  ${name}`;
          try {
            const raw = await fs.readFile(path.join(AUTO_SKILLS_DIR, `${name}.status.json`), 'utf-8');
            const s = JSON.parse(raw);
            info += `  [${s.status}]`;
            if (s.stats) info += `  ${(s.stats.successRate * PERCENTAGE_BASE).toFixed(0)}% (${s.stats.successfulRuns}/${s.stats.totalRuns})`;
          } catch {
            info += '  [no status]';
          }
          lines.push(info);
        }
        onOutput(lines.join('\n'));
        break;
      }
      case 'view': {
        if (!skillName) {
          onOutput('Usage: /review view <skill-name>');
          return;
        }
        const content = await fs.readFile(path.join(AUTO_SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8');
        onOutput(content);
        break;
      }
      case 'keep': {
        if (!skillName) {
          onOutput('Usage: /review keep <skill-name>');
          return;
        }
        const store = useTuiStore.getState();
        store.keepReviewSkill(skillName);
        // Update status.json
        try {
          const statusPath = path.join(AUTO_SKILLS_DIR, `${skillName}.status.json`);
          const raw = await fs.readFile(statusPath, 'utf-8');
          const status = JSON.parse(raw);
          status.status = 'kept';
          await fs.writeFile(statusPath, JSON.stringify(status, null, 2), 'utf-8');
        } catch {
          // status file may not exist; still mark as kept in store
        }
        onOutput(`Skill "${skillName}" marked as kept.`);
        break;
      }
      case 'delete': {
        if (!skillName) {
          onOutput('Usage: /review delete <skill-name>');
          return;
        }
        await fs.rm(path.join(AUTO_SKILLS_DIR, skillName), { recursive: true, force: true });
        await fs.rm(path.join(AUTO_SKILLS_DIR, `${skillName}.status.json`), { force: true });
        const store = useTuiStore.getState();
        store.deleteReviewSkill(skillName);
        onOutput(`Skill "${skillName}" deleted.`);
        break;
      }
      case 'edit': {
        if (!skillName) {
          onOutput('Usage: /review edit <skill-name>');
          return;
        }
        const skillPath = path.join(AUTO_SKILLS_DIR, skillName, 'SKILL.md');
        try {
          await fs.access(skillPath);
          onOutput(`Opening ${skillPath} for editing.`);
          onOutput(`\`\`\`edit\nfile: ${skillPath}\n\`\`\``);
        } catch {
          onOutput(`Skill "${skillName}" not found.`);
        }
        break;
      }
      default:
        onOutput('Usage: /review [list|view|keep|delete|edit] [skill-name]');
    }
  } catch (err) {
    onOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createReviewCommands(): SlashCommand[] {
  return [
    {
      name: 'review',
      description: 'Manage auto-generated skills. Sub-commands: list, view, keep, delete.',
      type: 'builtin',
      handler: handleReview,
    },
  ];
}
