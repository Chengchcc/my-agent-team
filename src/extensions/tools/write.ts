import fs from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { WriteArgs } from '../../application/contracts/tool-schemas/write';
import { buildDiffHunks } from './_diff';

export async function writeExecute(params: WriteArgs, ctx: ToolContext) {
  const resolvedPath = path.resolve(ctx.environment.cwd, params.path);
  let prior = '';
  let existed = false;
  try {
    prior = await fs.readFile(resolvedPath, 'utf-8');
    existed = true;
  } catch { /* new file */ }
  if (existed && !params.overwrite) {
    return { error: `File exists at ${resolvedPath}. Pass overwrite=true to replace.` };
  }
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, params.content, 'utf-8');
  const lineCount = params.content.split('\n').length;
  if (!existed) {
    return { result: `Created ${resolvedPath} (${lineCount} lines)`, path: resolvedPath, created: true };
  }
  const hunks = buildDiffHunks(prior, params.content);
  return { result: `Wrote ${resolvedPath} (${lineCount} lines)`, path: resolvedPath, diff: { hunks } };
}
