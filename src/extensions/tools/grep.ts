import { exec } from 'child_process';
import type { ToolContext } from '../../application/ports/tool-context';
import type { GrepArgs } from '../../application/contracts/tool-schemas/grep';

export function grepExecute(
  args: GrepArgs,
  _ctx: ToolContext,
): Promise<{ content: string }> {
  const globArg = args.glob ? `--glob '${args.glob}'` : '';
  const cmd = `rg -n ${globArg} '${args.pattern}' '${args.path}' 2>/dev/null || grep -rn '${args.pattern}' '${args.path}' 2>/dev/null || echo 'No matches found.'`;
  return new Promise((resolve) => {
    exec(cmd, { cwd: process.cwd() }, (_error, stdout) => {
      resolve({ content: stdout.trim() || 'No matches found.' });
    });
  });
}
