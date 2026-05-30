import fs from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { EditArgs } from '../../application/contracts/tool-schemas/edit';
import { buildDiffHunks } from './_diff';

export async function editExecute(params: EditArgs, ctx: ToolContext) {
  const resolvedPath = path.resolve(ctx.environment.cwd, params.path);
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch {
    return { error: `File ${resolvedPath} does not exist.` };
  }
  if (!content.includes(params.old_string)) {
    return { error: 'old_string not found in file.' };
  }
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(params.old_string, pos)) !== -1) {
    count++;
    pos += params.old_string.length;
  }
  if (count > 1) {
    return { error: `old_string found ${count} times; be more specific.` };
  }
  const newContent = content.replace(params.old_string, params.new_string);
  await fs.writeFile(resolvedPath, newContent, 'utf-8');
  const hunks = buildDiffHunks(content, newContent);
  return { result: `Updated ${resolvedPath}`, path: resolvedPath, diff: { hunks } };
}
