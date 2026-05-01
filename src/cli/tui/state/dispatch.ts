import type {
  UIState,
  UIAction,
  FinalizedAction,
  ActiveAction,
  InteractionAction,
  StatsAction,
} from './types';
import { initialUIState } from './types';
import { finalizedReducer, pushFinalizedAssistant } from './finalized-reducer';
import { activeReducer, activeToSegments } from './active-reducer';
import { interactionReducer } from './interaction-reducer';
import { statsReducer } from './stats-reducer';

export function uiReducer(state: UIState, action: UIAction): UIState {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (action.type) {
    // ── Cross-slice actions ──

    case 'FLUSH_TO_FINALIZED': {
      if (!state.active.streamingAssistant) return state;
      const segments = activeToSegments(state.active);
      const finalized = pushFinalizedAssistant(state.finalizedItems, {
        id: state.active.streamingAssistant.id,
        segments,
      });
      return {
        ...state,
        finalizedItems: finalized,
        active: { streamingAssistant: null },
        stats: statsReducer(state.stats, { type: 'STREAMING_STOP' }),
      };
    }

    // Append streaming text chunk to Static and advance flushed offset
    case 'APPEND_STREAMING_CHUNK': {
      if (!state.active.streamingAssistant) return state;
      const segs = state.active.streamingAssistant.segments;
      let lastTextFlushed = 0;
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i]!;
        if (seg.kind === 'text') {
          lastTextFlushed = seg.flushedLength;
          break;
        }
      }
      return {
        ...state,
        finalizedItems: finalizedReducer(state.finalizedItems, action),
        active: activeReducer(state.active, {
          type: 'ADVANCE_FLUSHED_LENGTH',
          length: lastTextFlushed + action.content.length,
        }),
      };
    }

    case 'CLEAR_ACTIVE':
      return {
        ...state,
        active: activeReducer(state.active, action),
        stats: statsReducer(state.stats, { type: 'STREAMING_STOP' }),
      };

    case 'RESET_FINALIZED_FROM_MESSAGES':
      return {
        ...state,
        finalizedItems: finalizedReducer(state.finalizedItems, action),
        active: { streamingAssistant: null },
      };

    // ── Route to single-slice reducers ──

    default:
      return {
        ...state,
        finalizedItems: isFinalizedAction(action)
          ? finalizedReducer(state.finalizedItems, action)
          : state.finalizedItems,
        active: isActiveAction(action)
          ? activeReducer(state.active, action)
          : state.active,
        interaction: isInteractionAction(action)
          ? interactionReducer(state.interaction, action)
          : state.interaction,
        stats: isStatsAction(action)
          ? statsReducer(state.stats, action)
          : state.stats,
      };
  }
}

export { initialUIState };

// ── Action type guards ──

function isFinalizedAction(a: UIAction): a is FinalizedAction {
  return (
    a.type === 'USER_SUBMIT' ||
    a.type === 'ASSISTANT_DONE' ||
    a.type === 'APPEND_STREAMING_CHUNK' ||
    a.type === 'APPEND_DIVIDER' ||
    a.type === 'APPEND_SYSTEM_NOTICE' ||
    a.type === 'RESET_FINALIZED_FROM_MESSAGES'
  );
}

function isActiveAction(a: UIAction): a is ActiveAction {
  return (
    a.type === 'ASSISTANT_START' ||
    a.type === 'STREAM_TEXT_DELTA' ||
    a.type === 'THINKING_DELTA' ||
    a.type === 'TOOL_START' ||
    a.type === 'TOOL_DONE' ||
    a.type === 'TOOL_ERROR' ||
    a.type === 'ADVANCE_FLUSHED_LENGTH' ||
    a.type === 'FLUSH_TO_FINALIZED' ||
    a.type === 'CLEAR_ACTIVE'
  );
}

function isInteractionAction(a: UIAction): a is InteractionAction {
  return (
    a.type === 'FOCUS_TOOL' ||
    a.type === 'TOGGLE_EXPANDED' ||
    a.type === 'MOVE_FOCUS' ||
    a.type === 'IGNORE_ERROR' ||
    a.type === 'ENQUEUE_PENDING_INPUT' ||
    a.type === 'DEQUEUE_PENDING_INPUT' ||
    a.type === 'REMOVE_PENDING_INPUT' ||
    a.type === 'CLEAR_PENDING_INPUTS'
  );
}

function isStatsAction(a: UIAction): a is StatsAction {
  return (
    a.type === 'STREAMING_START' ||
    a.type === 'STREAMING_STOP' ||
    a.type === 'ACCUMULATE_USAGE' ||
    a.type === 'SET_CONTEXT_TOKENS' ||
    a.type === 'SET_TOKEN_LIMIT' ||
    a.type === 'SET_INTERRUPTED'
  );
}
