import type { Message, ContentBlock } from '../../../types';
import type { FinalItem, AssistantSegment } from './types';

// ── Messages → FinalizedItems (resume path) ──

let _nextId = 0;
function nextId(): string {
  return `r-${_nextId++}`;
}

export function resetNextId(): void {
  _nextId = 0;
}

export function messagesToFinalizedItems(messages: Message[]): FinalItem[] {
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, {
        content: msg.content,
        isError: msg.name === 'error' || false,
      });
    }
  }

  const items: FinalItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') continue;

    if (msg.role === 'user') {
      items.push({ kind: 'user-message', id: msg.id ?? nextId(), content: msg.content });
    } else if (msg.role === 'assistant') {
      const segments = blocksToSegments(msg.blocks ?? [], toolResults);
      if (segments.length > 0) {
        items.push({
          kind: 'assistant-message',
          id: msg.id ?? nextId(),
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
        id: `ts-${nextId()}`,
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
          : null,
      });
    }
  }
  return segments;
}
