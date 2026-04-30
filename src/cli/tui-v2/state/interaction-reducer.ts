import type { InteractionState, InteractionAction } from './types';

export function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case 'FOCUS_TOOL':
      return { ...state, focusedToolId: action.id };

    case 'TOGGLE_EXPANDED': {
      if (!state.focusedToolId) return state;
      const next = new Set(state.expandedTools);
      if (next.has(state.focusedToolId)) {
        next.delete(state.focusedToolId);
      } else {
        next.add(state.focusedToolId);
      }
      return { ...state, expandedTools: next };
    }

    case 'MOVE_FOCUS': {
      const { collapsibleToolIds, direction } = action;
      if (collapsibleToolIds.length === 0) return { ...state, focusedToolId: null };
      let idx = state.focusedToolId ? collapsibleToolIds.indexOf(state.focusedToolId) : -1;
      idx += direction;
      if (idx < 0) idx = collapsibleToolIds.length - 1;
      if (idx >= collapsibleToolIds.length) idx = 0;
      return { ...state, focusedToolId: collapsibleToolIds[idx] ?? null };
    }

    case 'IGNORE_ERROR': {
      const next = new Set(state.ignoredErrors);
      next.add(action.toolId);
      return { ...state, ignoredErrors: next };
    }

    case 'ENQUEUE_PENDING_INPUT':
      return { ...state, pendingInputs: [...state.pendingInputs, action.text] };

    case 'DEQUEUE_PENDING_INPUT':
      return { ...state, pendingInputs: state.pendingInputs.slice(1) };

    case 'REMOVE_PENDING_INPUT':
      return { ...state, pendingInputs: state.pendingInputs.filter((_, i) => i !== action.index) };

    case 'CLEAR_PENDING_INPUTS':
      return { ...state, pendingInputs: [] };

    default:
      return state;
  }
}
