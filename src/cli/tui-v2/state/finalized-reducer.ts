import type { FinalItem, FinalizedAction, AssistantSegment } from './types';

export function finalizedReducer(items: FinalItem[], action: FinalizedAction): FinalItem[] {
  switch (action.type) {
    case 'USER_SUBMIT':
      return [...items, { kind: 'user-message', id: action.id, content: action.content }];

    case 'ASSISTANT_DONE':
      // FLUSH_TO_FINALIZED in activeReducer handles pushing the finalized item.
      return items;

    case 'APPEND_STREAMING_CHUNK':
      return [...items, { kind: 'streaming-chunk', id: action.id, content: action.content }];

    case 'APPEND_DIVIDER':
      return [...items, { kind: 'divider', reason: action.reason }];

    default:
      return items;
  }
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
