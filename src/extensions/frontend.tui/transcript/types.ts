import type { HistoryRecordV1 } from '../../../application/contracts';

export type TranscriptEvent =
  | { type: 'session_snapshot_loaded'; sessionId: string; records: HistoryRecordV1[] }
  | { type: 'user_message'; sessionId: string; turnId: string; content: string }
  | { type: 'turn_started'; sessionId: string; turnId: string }
  | { type: 'assistant_text_delta'; sessionId: string; turnId: string; delta: string; roundIndex: number }
  | { type: 'assistant_text_final'; sessionId: string; turnId: string; roundIndex: number; fullText: string }
  | { type: 'tool_call_started'; sessionId: string; turnId: string; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_finished'; sessionId: string; turnId: string; callId: string; name: string; result: unknown; isError: boolean; durationMs: number }
  | { type: 'turn_completed'; sessionId: string; turnId: string; usage: { input: number; output: number }; finalMessage: string }
  | { type: 'turn_failed'; sessionId: string; turnId: string; stage: string; reason: string }
  | { type: 'system_notice'; sessionId: string; message: string }
  | { type: 'permission_requested'; sessionId: string; reqId: string; toolName: string }
  | { type: 'user_question_requested'; sessionId: string; questionId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }> }
  | { type: 'widget_inline_block'; sessionId: string; blockId: string; widget: string; payload: unknown; mode: 'append' | 'replace' };

