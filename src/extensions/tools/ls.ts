import { readdir } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { LsArgs } from '../../application/contracts/tool-schemas/ls';

export async function lsExecute(
  args: LsArgs,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  try {
    const dirPath = path.resolve(ctx.environment.cwd, args.path);
    const files = await readdir(dirPath);
    const filtered = args.a ? files : files.filter((f) => !f.startsWith('.'));
    return { content: filtered.join('\n') || '(empty directory)' };
  } catch (err: unknown) {
    return { content: `Error: ${(err as Error).message}`, isError: true };
  }
}
