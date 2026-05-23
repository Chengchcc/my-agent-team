import { readdir } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { GlobArgs } from '../../application/contracts/tool-schemas/glob';

const GLOB_EXT_PREFIX_LEN = 4
const GLOB_MAX_RESULTS = 500

export async function globExecute(
  args: GlobArgs,
  ctx: ToolContext,
): Promise<{ content: string }> {
  const basePath = path.resolve(ctx.environment.cwd, args.path);
  const results: string[] = [];

  async function walk(d: string): Promise<void> {
    try {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          await walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(basePath, full);
          if (matchSimple(rel, args.pattern)) results.push(rel);
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  function matchSimple(file: string, pat: string): boolean {
    if (pat === '**/*') return true;
    if (pat.startsWith('**/*.')) return file.endsWith(pat.slice(GLOB_EXT_PREFIX_LEN));
    return file.includes(pat.replace(/\*/g, ''));
  }

  await walk(basePath);
  return { content: results.slice(0, GLOB_MAX_RESULTS).join('\n') || 'No matching files found.' };
}
