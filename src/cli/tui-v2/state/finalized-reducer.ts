import type { FinalItem, FinalizedAction, AssistantSegment } from './types';
import type { Message, ContentBlock } from '../../../types';

export function finalizedReducer(items: FinalItem[], action: FinalizedAction): FinalItem[] {
  switch (action.type) {
    case 'USER_SUBMIT':
      return [...items, { kind: 'user-message', id: action.id, content: action.content }];

    case 'ASSISTANT_DONE':
      // FLUSH_TO_FINALIZED in dispatch handles pushing the finalized item.
      return items;

    case 'APPEND_STREAMING_CHUNK':
      return [...items, { kind: 'streaming-chunk', id: action.id, content: action.content }];

    case 'APPEND_DIVIDER':
      return [...items, { kind: 'divider', reason: action.reason }];

    case 'APPEND_SYSTEM_NOTICE':
      return [...items, { kind: 'system-notice', id: action.id, content: action.content }];

    case 'RESET_FINALIZED_FROM_MESSAGES':
      return messagesToFinalizedItems(action.messages);

    default:
      return items;
  }
}

let _nextId = 0;
function nextId(): string {
  return `r-${_nextId++}`;
}

export function resetNextId(): void {
  _nextId = 0;
}

function messagesToFinalizedItems(messages: Message[]): FinalItem[] {
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
        items.push({ kind: 'assistant-message', id: msg.id ?? nextId(), segments });
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
      segments.push({ kind: 'text', content: block.text, flushedLength: 0 });
    } else if (block.type === 'tool_use') {
      const result = toolResults.get(block.id);
      segments.push({
        kind: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
        result: result
          ? result.isError
            ? { kind: 'error', message: result.content, durationMs: 0 }
            : { kind: 'ok', content: result.content, durationMs: 0 }
          : null,
      });
    }
    // Skip thinking, redacted_thinking blocks
  }
  return segments;
}

export function pushFinalizedAssistant(
  items: FinalItem[],
  assistant: { id: string; segments: AssistantSegment[] },
): FinalItem[] {
  return [
    ...items,
    {
      kind: 'assistant-message',
      id: assistant.id,
      segments: assistant.segments,
    },
  ];
}
