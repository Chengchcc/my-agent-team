// ── Segments (ordered, interleaved text + tool_calls) ──

import type { Message } from '../../../types';

export interface TextSegment {
  kind: 'text';
  content: string;
  flushedLength: number;
}

export interface ToolCallSegment {
  kind: 'tool_call';
  id: string;
  name: string;
  input: unknown;
  result: ToolCallResult | null;
}

export type ToolCallResult =
  | { kind: 'ok'; content: string; durationMs: number }
  | { kind: 'error'; message: string; durationMs: number };

export interface ActiveToolCall extends ToolCallSegment {
  status: 'pending' | 'running' | 'done' | 'error';
}

export type ActiveSegment = TextSegment | ActiveToolCall;
export type AssistantSegment = TextSegment | ToolCallSegment;

// ── Finalized items (scrollback, never touched again) ──

export type FinalItem =
  | { kind: 'banner'; model: string; sessionId: string | null }
  | { kind: 'user-message'; id: string; content: string }
  | { kind: 'assistant-message'; id: string; segments: AssistantSegment[] }
  | { kind: 'streaming-chunk'; id: string; content: string }
  | { kind: 'divider'; reason: 'clear' | 'compact' }
  | { kind: 'system-notice'; id: string; content: string };

// ── Slice states ──

export interface ActiveState {
  streamingAssistant: {
    id: string;
    segments: ActiveSegment[];
    thinking: string | null;
  } | null;
}

export interface InteractionState {
  focusedToolId: string | null;
  expandedTools: Set<string>;
  ignoredErrors: Set<string>;
  pendingInputs: string[];
}

export interface StatsState {
  promptTokens: number;
  completionTokens: number;
  contextTokens: number;
  tokenLimit: number;
  streaming: boolean;
  streamingStartTime: number | null;
  interrupted: boolean;
}

export interface UIState {
  finalizedItems: FinalItem[];
  active: ActiveState;
  interaction: InteractionState;
  stats: StatsState;
}

// ── Actions ──

export type FinalizedAction =
  | { type: 'USER_SUBMIT'; id: string; content: string }
  | { type: 'ASSISTANT_DONE' }
  | { type: 'APPEND_STREAMING_CHUNK'; id: string; content: string }
  | { type: 'APPEND_DIVIDER'; reason: 'clear' | 'compact' }
  | { type: 'APPEND_SYSTEM_NOTICE'; id: string; content: string }
  | { type: 'RESET_FINALIZED_FROM_MESSAGES'; messages: Message[] };

export type ActiveAction =
  | { type: 'ASSISTANT_START'; id: string }
  | { type: 'STREAM_TEXT_DELTA'; delta: string }
  | { type: 'THINKING_DELTA'; delta: string }
  | { type: 'TOOL_START'; id: string; name: string; input: unknown }
  | { type: 'TOOL_DONE'; id: string; result: ToolCallResult }
  | { type: 'TOOL_ERROR'; id: string; message: string; durationMs: number }
  | { type: 'ADVANCE_FLUSHED_LENGTH'; length: number }
  | { type: 'FLUSH_TO_FINALIZED' }
  | { type: 'CLEAR_ACTIVE' };

export type InteractionAction =
  | { type: 'FOCUS_TOOL'; id: string }
  | { type: 'TOGGLE_EXPANDED' }
  | { type: 'MOVE_FOCUS'; direction: -1 | 1; collapsibleToolIds: string[] }
  | { type: 'IGNORE_ERROR'; toolId: string }
  | { type: 'ENQUEUE_PENDING_INPUT'; text: string }
  | { type: 'DEQUEUE_PENDING_INPUT' }
  | { type: 'REMOVE_PENDING_INPUT'; index: number }
  | { type: 'CLEAR_PENDING_INPUTS' };

export type StatsAction =
  | { type: 'STREAMING_START' }
  | { type: 'STREAMING_STOP' }
  | { type: 'ACCUMULATE_USAGE'; usage: { prompt_tokens: number; completion_tokens: number } }
  | { type: 'SET_CONTEXT_TOKENS'; tokens: number }
  | { type: 'SET_TOKEN_LIMIT'; limit: number }
  | { type: 'SET_INTERRUPTED'; interrupted: boolean };

export type UIAction = FinalizedAction | ActiveAction | InteractionAction | StatsAction;

// ── Initial states ──

export const initialActive: ActiveState = {
  streamingAssistant: null,
};

export const initialInteraction: InteractionState = {
  focusedToolId: null,
  expandedTools: new Set(),
  ignoredErrors: new Set(),
  pendingInputs: [],
};

export const initialStats: StatsState = {
  promptTokens: 0,
  completionTokens: 0,
  contextTokens: 0,
  tokenLimit: 0,
  streaming: false,
  streamingStartTime: null,
  interrupted: false,
};

export const initialUIState: UIState = {
  finalizedItems: [],
  active: initialActive,
  interaction: initialInteraction,
  stats: initialStats,
};
