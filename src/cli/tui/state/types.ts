// ── Segments (ordered, interleaved text + tool_calls) ──

export interface TextSegment {
  kind: 'text';
  id: string;           // stable id, survives active → finalized
  content: string;      // full text, append-only
  committedLength: number;  // prefix already in Static; only increases
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

export type AssistantSegment = TextSegment | ToolCallSegment;

// ── Finalized items (scrollback) ──

export type FinalItem =
  | { kind: 'banner'; model: string; sessionId: string | null }
  | { kind: 'user-message'; id: string; content: string }
  | { kind: 'assistant-message'; id: string; segments: AssistantSegment[]; status: 'streaming' | 'done' }
  | { kind: 'divider'; reason: 'clear' | 'compact' }
  | { kind: 'system-notice'; id: string; content: string };

// ── Review notifications ──

export interface ReviewNotification {
  skillName: string;
  description: string;
  outputDir: string;
  dismissed: boolean;
  createdAt: number;
  kept?: boolean;
  deleted?: boolean;
}

// ── Slice states ──

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
  compacting: boolean;
}

// ── Initial states ──

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
  compacting: false,
};
