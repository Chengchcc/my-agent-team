import type { HistoryRecordV1, ContentBlock } from '../../../application/contracts';
import type { FinalItem, AssistantSegment } from './types';
import { nanoid } from 'nanoid';

const RANDOM_ID_LENGTH = 8

// ── HistoryRecords → FinalizedItems (resume path) ──

export function historyToFinalizedItems(records: HistoryRecordV1[]): FinalItem[] {
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const r of records) {
    if (r.role === 'tool' && r.tool_call_id) {
      toolResults.set(r.tool_call_id, {
        content: r.content ?? '',
        isError: r.name === 'error' || false,
      });
    }
  }

  const items: FinalItem[] = [];
  for (const r of records) {
    if (r.role === 'system') continue;
    if (r.role === 'tool') continue;

    if (r.role === 'user') {
      const id = r.id ?? `user-${nanoid(RANDOM_ID_LENGTH)}`;
      items.push({ kind: 'user-message', id, content: r.content ?? '' });
    } else if (r.role === 'assistant') {
      // Convert generic blocks to ContentBlock[] for the existing helper
      const blocks = (r.blocks ?? []) as ContentBlock[];
      const segments = blocksToSegments(blocks, toolResults);
      if (segments.length > 0) {
        items.push({
          kind: 'assistant-message',
          id: r.id ?? `asst-${nanoid(RANDOM_ID_LENGTH)}`,
          segments,
          status: 'done' as const,
        });
      }
    }
  }
  return items;
}


function blocksToSegments(
  blocks: ContentBlock[],
  toolResults: Map<string, { content: string; isError: boolean }>,
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      segments.push({
        kind: 'text',
        id: `ts-${nanoid(RANDOM_ID_LENGTH)}`,
        content: block.text,
        committedLength: block.text.length,
      });
    } else if (block.type === 'tool_use') {
      const result = toolResults.get(block.id);
      segments.push({
        kind: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
        result: result
          ? result.isError
            ? { kind: 'error' as const, message: result.content, durationMs: 0 }
            : { kind: 'ok' as const, content: result.content, durationMs: 0 }
          : { kind: 'ok' as const, content: '(completed)', durationMs: 0 },
      });
    }
  }
  return segments;
}
