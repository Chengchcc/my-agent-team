import type { ActiveState, ActiveAction, ActiveSegment, AssistantSegment } from './types';

export function activeReducer(state: ActiveState, action: ActiveAction): ActiveState {
  switch (action.type) {
    case 'ASSISTANT_START':
      return {
        streamingAssistant: {
          id: action.id,
          segments: [],
          thinking: null,
        },
      };

    case 'STREAM_TEXT_DELTA': {
      if (!state.streamingAssistant) return state;
      const segs = state.streamingAssistant.segments;
      const last = segs[segs.length - 1];
      // Merge consecutive text segments — keeps markdown flow natural
      // and avoids creating excessive segments that cause re-render storms.
      const merged =
        last?.kind === 'text'
          ? replaceLast(segs, { ...last, content: last.content + action.delta })
          : [...segs, { kind: 'text' as const, content: action.delta }];
      return {
        streamingAssistant: { ...state.streamingAssistant, segments: merged },
      };
    }

    case 'THINKING_DELTA': {
      if (!state.streamingAssistant) return state;
      return {
        streamingAssistant: {
          ...state.streamingAssistant,
          thinking: (state.streamingAssistant.thinking ?? '') + action.delta,
        },
      };
    }

    case 'TOOL_START': {
      if (!state.streamingAssistant) return state;
      return {
        streamingAssistant: {
          ...state.streamingAssistant,
          segments: [
            ...state.streamingAssistant.segments,
            {
              kind: 'tool_call' as const,
              id: action.id,
              name: action.name,
              input: action.input,
              result: null,
              status: 'running' as const,
            },
          ],
        },
      };
    }

    case 'TOOL_DONE': {
      if (!state.streamingAssistant) return state;
      return {
        streamingAssistant: {
          ...state.streamingAssistant,
          segments: updateSegmentById(state.streamingAssistant.segments, action.id, seg => ({
            ...seg,
            status: 'done' as const,
            result: action.result,
          })),
        },
      };
    }

    case 'TOOL_ERROR': {
      if (!state.streamingAssistant) return state;
      return {
        streamingAssistant: {
          ...state.streamingAssistant,
          segments: updateSegmentById(state.streamingAssistant.segments, action.id, seg => ({
            ...seg,
            status: 'error' as const,
            result: { kind: 'error' as const, message: action.message, durationMs: action.durationMs },
          })),
        },
      };
    }

    case 'FLUSH_TO_FINALIZED':
      // Handled by top-level reducer that reads both slices.
      return state;

    case 'CLEAR_ACTIVE':
      return { streamingAssistant: null };

    default:
      return state;
  }
}

export function activeToSegments(active: ActiveState): AssistantSegment[] {
  if (!active.streamingAssistant) return [];
  return active.streamingAssistant.segments.map(seg => {
    if (seg.kind === 'text') return seg;
    return {
      kind: 'tool_call' as const,
      id: seg.id,
      name: seg.name,
      input: seg.input,
      result: seg.result,
    };
  });
}

function replaceLast<T>(arr: T[], item: T): T[] {
  return [...arr.slice(0, -1), item];
}

function updateSegmentById(
  segs: ActiveSegment[],
  id: string,
  fn: (seg: ActiveSegment & { kind: 'tool_call' }) => ActiveSegment,
): ActiveSegment[] {
  return segs.map(s => (s.kind === 'tool_call' && s.id === id ? fn(s) : s));
}
