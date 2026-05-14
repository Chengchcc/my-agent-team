import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const daemonCommand: SlashCommand = {
  name: 'daemon',
  description: 'Browse running daemon sessions',
  type: 'builtin',
  handler: async (ctx: CommandHandlerContext): Promise<void> => {
    const daemonDir = join(homedir() ?? '/root', '.my-agent', 'data');
    if (!existsSync(daemonDir)) {
      ctx.onOutput('No daemon data directory found. Start a daemon first with `my-agent daemon start <profile>`.');
      return;
    }

    const pidFiles = readdirSync(daemonDir).filter(f => f.endsWith('.pid'));
    if (pidFiles.length === 0) {
      ctx.onOutput('No running daemons found. Start a daemon first with `my-agent daemon start <profile>`.');
      return;
    }

    const lines: string[] = ['**Running Daemons:**', ''];
    for (const pf of pidFiles) {
      try {
        const pid = readFileSync(join(daemonDir, pf), 'utf-8').trim();
        const profileName = pf.replace('.pid', '');
        lines.push(`- **${profileName}** (PID: ${pid})`);
      } catch {
        lines.push(`- ${pf.replace('.pid', '')}`);
      }
    }
    ctx.onOutput(lines.join('\n'));
  },
};
