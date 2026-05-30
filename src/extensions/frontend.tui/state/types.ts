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
  | { kind: 'assistant-message'; id: string; segments: AssistantSegment[]; status: 'done' }
  | { kind: 'assistant-header'; id: string; assistantId: string }
  | { kind: 'committed-block'; id: string; assistantId: string; segId: string; blockId: string; raw: string }
  | { kind: 'tool-call-final'; id: string; assistantId: string; name: string; input: unknown; result: ToolCallResult }
  | { kind: 'assistant-tail'; id: string; assistantId: string; raw: string }
  | { kind: 'divider'; reason: 'clear' | 'compact' }
  | { kind: 'system-notice'; id: string; content: string }
  | { kind: 'widget'; blockId: string; widget: string; payload: unknown; mode: 'append' | 'replace' }
  | { kind: 'subagent-block'; id: string; callId: string; type: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt: number; completedAt?: number; finalText?: string; usage?: { input: number; output: number } };

// ── Todos ──

export interface UITodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

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
  toolsExpanded: boolean;
  pendingInputs: string[];
}

export interface StatsState {
  lastTurnInputTokens: number;
  completionTokens: number;
  tokenLimit: number;
  streaming: boolean;
  streamingStartTime: number | null;
  interrupted: boolean;
  compacting: boolean;
  mode: string;
}

// ── Session picker ──

export interface SessionPickerSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastUserMessage: string;
}

export interface SessionPickerState {
  active: boolean;
  sessions: SessionPickerSession[];
  selectedIndex: number;
}

// ── Initial states ──

export const initialInteraction: InteractionState = {
  toolsExpanded: false,
  pendingInputs: [],
};

export const initialStats: StatsState = {
  lastTurnInputTokens: 0,
  completionTokens: 0,
  tokenLimit: 0,
  streaming: false,
  streamingStartTime: null,
  interrupted: false,
  compacting: false,
  mode: 'normal',
};

export const initialSessionPicker: SessionPickerState = {
  active: false,
  sessions: [],
  selectedIndex: 0,
};
