import type { ToolCallRecord } from '../../domain/turn-runner.types';
import type { HistoryRecordV1 } from '../contracts';

// ── Append history — pure function, no IO ─────────────────────────────────────

let _seq = 0;
function nextId(): string {
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- toString radix
  return `hist-${Date.now().toString(36)}-${(_seq++).toString(36)}`;
}

function base(
  sessionId: string,
  turnId: string | undefined,
  role: HistoryRecordV1['role'],
): Pick<HistoryRecordV1, 'kind' | 'version' | 'sessionId' | 'turnId' | 'role' | 'ts'> {
  return { kind: 'history.record', version: 1, sessionId, turnId, role, ts: Date.now() };
}

export function appendHistory(args: {
  sessionId: string;
  turnId?: string;
  userInput: string;
  toolCalls: ReadonlyArray<ToolCallRecord>;
  finalText: string;
}): HistoryRecordV1[] {
  const out: HistoryRecordV1[] = [];

  // User input
  out.push({ ...base(args.sessionId, args.turnId, 'user'), content: args.userInput, id: nextId() });

  if (args.toolCalls.length > 0) {
    // Assistant message with tool_use blocks
    out.push({
      ...base(args.sessionId, args.turnId, 'assistant'),
      blocks: args.toolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })),
      id: nextId(),
    });
    // Tool results
    for (const tc of args.toolCalls) {
      out.push({
        ...base(args.sessionId, args.turnId, 'tool'),
        tool_call_id: tc.id,
        name: tc.name,
        content: tc.resultText,
      });
    }
    // Final assistant text after tools
    if (args.finalText) {
      out.push({
        ...base(args.sessionId, args.turnId, 'assistant'),
        blocks: [{ type: 'text', text: args.finalText }],
        id: nextId(),
      });
    }
  } else {
    // No tool calls: simple text response
    out.push({
      ...base(args.sessionId, args.turnId, 'assistant'),
      blocks: [{ type: 'text', text: args.finalText }],
      id: nextId(),
    });
  }

  return out;
}
