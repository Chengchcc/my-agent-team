import { structuredPatch } from 'diff';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ kind: 'context' | 'added' | 'removed'; text: string }>;
}

export function buildDiffHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = structuredPatch('', '', oldText, newText, '', '', { context: 3 });
  return patch.hunks.map(h => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.map(l => ({
      kind: (l.startsWith('+') ? 'added' : l.startsWith('-') ? 'removed' : 'context') as DiffHunk['lines'][number]['kind'],
      text: l.slice(1),
    })),
  }));
}
