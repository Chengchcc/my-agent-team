/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Source: https://github.com/zarazhangrui/feishu-claude-code-bridge/blob/main/src/card/tool-render.ts
 * Modifications: none.
 */
import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;
const GREP_PATTERN_MAX = 40;
const GREP_PATH_MAX = 30;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
const BODY_TOTAL_MAX = 2500;

export function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '\u2705' : tool.status === 'error' ? '\u274C' : '\u23F3';
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
  } else if (tool.status === 'running') {
    parts.push('_\u8FD0\u884C\u4E2D\u2026_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}\u2026\n\n_(body \u5DF2\u622A\u65AD)_`;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}\u2026` : oneLine;
  };
  switch (name) {
    case 'Bash': return pick('command');
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return shortenPath(pick('file_path'));
    case 'Grep': { const pat = pick('pattern', GREP_PATTERN_MAX); const path = pick('path', GREP_PATH_MAX); return path ? `${pat} in ${shortenPath(path)}` : pat; }
    case 'Glob': return pick('pattern');
    case 'WebFetch': return pick('url');
    case 'WebSearch': return pick('query', 60);
    case 'Agent': case 'Task': return pick('description') || pick('subagent_type');
    default: return pick('command') || pick('file_path') || pick('path') || pick('query');
  }
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '');
  switch (tool.name) {
    case 'Bash': { const cmd = str('command'); return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : ''; }
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': { const fp = str('file_path'); return fp ? `**File** \`${fp}\`` : ''; }
    case 'Grep': { const lines: string[] = []; if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``); if (str('path')) lines.push(`**Path** \`${str('path')}\``); return lines.join('\n'); }
    case 'WebFetch': return str('url') ? `**URL** ${str('url')}` : '';
    case 'WebSearch': return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    default: return '';
  }
}

function shortenPath(p: string): string {
  if (!p) return p;
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
