import fs from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { TextEditorArgs } from '../../application/contracts/tool-schemas/text-editor';

const LINE_NUMBER_PAD_WIDTH = 6;

export type TextEditorOptions = {
  allowedRoots?: string[];
};

export function createTextEditorExecute(options: TextEditorOptions = {}) {
  const allowedRoots = options.allowedRoots ?? [];

  function validatePath(resolvedPath: string): boolean {
    if (!allowedRoots || allowedRoots.length === 0) return true;
    const resolved = path.resolve(resolvedPath);
    return allowedRoots.some((root) => {
      const resolvedAllowed = path.resolve(root);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
    });
  }

  async function view(resolvedPath: string, startLine?: number, endLine?: number): Promise<{ result: string } | { error: string }> {
    let content = await fs.readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    if (startLine !== undefined) {
      const start = Math.max(0, startLine - 1);
      const end = endLine !== undefined ? endLine : lines.length;
      const selected = lines.slice(start, end);
      const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(LINE_NUMBER_PAD_WIDTH, ' ')} ${line}`);
      return { result: numbered.join('\n') };
    }
    return { result: content };
  }

  async function create(resolvedPath: string, content: string): Promise<{ result: string } | { error: string }> {
    try {
      await fs.access(resolvedPath);
      return { error: `Error: File already exists at ${resolvedPath}. Use str_replace or write to modify it.` };
    } catch {
      const dirPath = path.dirname(resolvedPath);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');
      return { result: `Created file ${resolvedPath} successfully.` };
    }
  }

  async function strReplace(resolvedPath: string, oldString: string, newString: string): Promise<{ result: string } | { error: string }> {
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf-8');
    } catch (_e) {
      return { error: `Error: File ${resolvedPath} does not exist.` };
    }
    if (!content.includes(oldString)) {
      return { error: 'Error: old_string not found exactly once in file. Search failed.' };
    }
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(oldString, pos)) !== -1) { count++; pos += oldString.length; }
    if (count > 1) return { error: `Error: old_string found ${count} times in file. Please be more specific.` };
    const newContent = content.replace(oldString, newString);
    await fs.writeFile(resolvedPath, newContent, 'utf-8');
    return { result: `Replaced ${count} occurrence in ${resolvedPath} successfully.` };
  }

  async function write(resolvedPath: string, content: string): Promise<{ result: string } | { error: string }> {
    const dirPath = path.dirname(resolvedPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { result: `Wrote ${resolvedPath} successfully.` };
  }

  return async function textEditorExecute(
    params: TextEditorArgs,
    ctx: ToolContext,
  ): Promise<{ result: string } | { error: string }> {
    const { command, path: inputPath } = params;
    const resolvedPath = path.resolve(ctx.environment.cwd, inputPath);
    if (!validatePath(resolvedPath)) return { error: `Error: Path "${resolvedPath}" is not allowed.` };
    try {
      switch (command) {
        case 'view': return view(resolvedPath, params.start_line, params.end_line);
        case 'create': {
          if (!params.content) return { error: 'Error: content is required for create command.' };
          return create(resolvedPath, params.content);
        }
        case 'str_replace': {
          if (!params.old_string) return { error: 'Error: old_string is required for str_replace command.' };
          if (params.new_string === undefined) return { error: 'Error: new_string is required for str_replace command.' };
          return strReplace(resolvedPath, params.old_string, params.new_string);
        }
        case 'write': {
          if (!params.content) return { error: 'Error: content is required for write command.' };
          return write(resolvedPath, params.content);
        }
        default:
          return { error: `Error: unknown command "${command}".` };
      }
    } catch (e) {
      return { error: `Error: ${(e as Error).message}` };
    }
  };
}
