import type { DataPlaneEvent } from '../../../application/contracts';
import type { TranscriptEvent } from './types';
import { nanoid } from 'nanoid';

const RANDOM_ID_LENGTH = 8
let roundIndex = 0;

function unwrap(p: Record<string, unknown>): Record<string, unknown> {
  // Contracted events (via contractBus.emit) are wrapped in EventEnvelope
  if (p.payload && typeof p.payload === 'object') {
    return p.payload as Record<string, unknown>;
  }
  return p;
}

// eslint-disable-next-line complexity -- pre-existing event mapping function
export function dataplaneToTranscriptEvent(event: DataPlaneEvent): TranscriptEvent | null {
  const p = event.payload as Record<string, unknown>;
  const inner = unwrap(p);
  const sid = (event.sessionId ?? inner.sessionId ?? 'main') as string;
  const tid = (inner.turnId ?? `turn-${nanoid(RANDOM_ID_LENGTH)}`) as string;

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- intentional default catch-all, not all event types need transcript mapping
  switch (event.type) {
    case 'turn.started':
      roundIndex = 0;
      return { type: 'turn_started', sessionId: sid, turnId: tid };

    case 'assistant.delta':
      return { type: 'assistant_text_delta', sessionId: sid, turnId: tid, delta: String(inner.delta ?? ''), roundIndex };

    case 'tool.update': {
      const phase = p.phase as string | undefined; // phase is added by dataplane at top level
      const id = String(inner.callId ?? inner.toolCallId ?? '');
      const name = String(inner.name ?? inner.toolName ?? '');
      const args = (inner.args ?? inner.input ?? {}) as Record<string, unknown>;
      if (phase === 'start') {
        return { type: 'tool_call_started', sessionId: sid, turnId: tid, callId: id, name, input: args };
      }
      roundIndex++;
      return {
        type: 'tool_call_finished', sessionId: sid, turnId: tid, callId: id, name,
        result: inner.result, isError: (inner.isError as boolean) ?? false,
        durationMs: (inner.durationMs as number) ?? 0,
      };
    }

    case 'turn.completed':
      return {
        type: 'turn_completed', sessionId: sid, turnId: tid,
        usage: { input: (inner.usage as Record<string, number>)?.input ?? 0, output: (inner.usage as Record<string, number>)?.output ?? 0 },
        finalMessage: String(inner.finalMessage ?? ''),
      };

    case 'turn.failed':
      return { type: 'turn_failed', sessionId: sid, turnId: tid, stage: String(inner.stage ?? ''), reason: String(inner.reason ?? '') };

    case 'permission.required':
      return { type: 'permission_requested', sessionId: sid, reqId: String(inner.reqId ?? ''), toolName: String(inner.toolName ?? '') };

    case 'tui.inline-block':
      return {
        type: 'widget_inline_block', sessionId: sid,
        blockId: String(inner.blockId ?? ''),
        widget: String(inner.widget ?? ''),
        payload: inner.payload,
        mode: (inner.mode as 'append' | 'replace') ?? 'append',
      };

    case 'compaction.started':
      return { type: 'compaction_started', sessionId: sid, turnId: tid }
    case 'compaction.completed':
      return { type: 'compaction_completed', sessionId: sid, turnId: tid }
    case 'compaction.failed':
      return { type: 'compaction_failed', sessionId: sid, turnId: tid, reason: String(inner.reason ?? '') }

    default:
      return null;
  }
}
