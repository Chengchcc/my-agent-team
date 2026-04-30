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

    case 'CLEAR_ACTIVE':
      return {
        ...state,
        active: activeReducer(state.active, action),
        stats: statsReducer(state.stats, { type: 'STREAMING_STOP' }),
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
  return a.type === 'USER_SUBMIT' || a.type === 'ASSISTANT_DONE' || a.type === 'APPEND_DIVIDER';
}

function isActiveAction(a: UIAction): a is ActiveAction {
  return (
    a.type === 'ASSISTANT_START' ||
    a.type === 'STREAM_TEXT_DELTA' ||
    a.type === 'THINKING_DELTA' ||
    a.type === 'TOOL_START' ||
    a.type === 'TOOL_DONE' ||
    a.type === 'TOOL_ERROR' ||
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
    a.type === 'SET_INTERRUPTED'
  );
}
