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
        promptTokens: action.usage.prompt_tokens,  // latest snapshot, not accumulated
        completionTokens: state.completionTokens + action.usage.completion_tokens,
      };

    case 'SET_CONTEXT_TOKENS':
      return { ...state, contextTokens: action.tokens };

    case 'SET_TOKEN_LIMIT':
      return { ...state, tokenLimit: action.limit };

    case 'SET_INTERRUPTED':
      return { ...state, interrupted: action.interrupted };

    default:
      return state;
  }
}
