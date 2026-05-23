import { z } from 'zod';
import { createCodec } from './shared/codec';

/**
 * HistoryRecordV1 — versioned session persistence format.
 * Unifies the three previously-duplicate types:
 *   - HistoryMessage (extensions/session/index.ts)
 *   - HistoryEntry  (application/usecases/append-history.ts)
 *   - SessionHistoryPort (application/ports/session-history.ts)
 */
export interface HistoryRecordV1 {
  kind: 'history.record';
  version: 1;
  sessionId: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  id?: string;
  tool_call_id?: string;
  name?: string;
  ts: number;
  metadata?: Record<string, unknown>;
}

const historyRecordCodec = createCodec<HistoryRecordV1>(
  z.object({
    kind: z.literal('history.record'),
    version: z.literal(1),
    sessionId: z.string(),
    turnId: z.string().optional(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string().optional(),
    blocks: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    })).optional(),
    id: z.string().optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    ts: z.number(),
    metadata: z.record(z.unknown()).optional(),
  }),
);

/**
 * Parse a raw NDJSON line into a HistoryRecordV1 or null.
 * Old format (no kind/version): returns null — caller should skip + warn.
 * Unknown future version: returns null — INV-Data-4 fail-soft.
 */
export function parseHistoryLine(line: string): HistoryRecordV1 | null {
  try {
    const raw = JSON.parse(line);
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) {
      return null; // legacy format, skip
    }
    if (raw.version !== 1) {
      return null; // future version, fail-soft
    }
    const result = historyRecordCodec.safeDecode(raw);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}
