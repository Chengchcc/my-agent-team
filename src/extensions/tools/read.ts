import type { ToolContext } from '../../application/ports/tool-context';
import type { ReadArgs } from '../../application/contracts/tool-schemas/read';
import { readFileSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { allowedRoots } from '../../config/allowed-roots';
import { isTextFile } from '../../utils/is-text-file';
import { getLanguageFromFilePath } from '../frontend.tui/components/utils/language-map';

export function readExecute(args: ReadArgs, ctx: ToolContext) {
  const resolvedPath = resolve(ctx.environment.cwd, args.path);

  if (!allowedRoots.some((root) => resolvedPath.startsWith(root))) {
    throw new Error(`File path ${resolvedPath} is not within allowed directories`);
  }

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch (e) {
    throw new Error(`Could not access file ${resolvedPath}: ${(e as Error).message}`);
  }

  if (stats.isDirectory()) {
    throw new Error(`Path ${resolvedPath} is a directory, use ls instead`);
  }

  if (!isTextFile(resolvedPath)) {
    throw new Error(`Path ${resolvedPath} appears to be a binary file, cannot read`);
  }

  const content = readFileSync(resolvedPath, { encoding: args.encoding });
  const lines = content.split('\n');
  const totalLines = lines.length;

  let start = args.start_line - 1;
  let end = args.end_line ? args.end_line - 1 : totalLines - 1;

  start = Math.max(0, Math.min(start, totalLines - 1));
  end = Math.max(start, Math.min(end, totalLines - 1));

  if (args.max_lines > 0) {
    const requestedLines = end - start + 1;
    if (requestedLines > args.max_lines) {
      end = start + args.max_lines - 1;
    }
  }

  const selectedLines = lines.slice(start, end + 1);
  const truncated = end - start + 1 < (args.end_line ? args.end_line - args.start_line + 1 : totalLines - start);

  return {
    path: resolvedPath,
    content: selectedLines.join('\n'),
    total_lines: totalLines,
    range: { start: start + 1, end: end + 1 },
    truncated,
    size_bytes: stats.size,
    language: getLanguageFromFilePath(resolvedPath) || extname(resolvedPath).slice(1) || 'text',
  };
}
