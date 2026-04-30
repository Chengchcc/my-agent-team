import type { StatsState, StatsAction } from './types';

export function statsReducer(state: StatsState, action: StatsAction): StatsState {
  switch (action.type) {
    case 'STREAMING_START':
      return { ...state, streaming: true, streamingStartTime: Date.now(), interrupted: false };

    case 'STREAMING_STOP':
      return { ...state, streaming: false, streamingStartTime: null };

    case 'ACCUMULATE_USAGE':
      return {
        ...state,
        promptTokens: state.promptTokens + action.usage.prompt_tokens,
        completionTokens: state.completionTokens + action.usage.completion_tokens,
        totalTokens: state.totalTokens + action.usage.total_tokens,
      };

    case 'SET_CONTEXT_TOKENS':
      return { ...state, contextTokens: action.tokens };

    case 'SET_INTERRUPTED':
      return { ...state, interrupted: action.interrupted };

    default:
      return state;
  }
}
