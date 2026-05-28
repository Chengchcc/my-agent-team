import type { TraceEventType } from '../../domain/trace-event'
import { TRACE_TRUNCATE_CHARS } from './trace-sanitizer'

export function mapTurnEventToTraceKind(t: string): TraceEventType | null {
  switch (t) {
    case 'tool.start': return 'tool.call'
    case 'tool.end':   return 'tool.result'
    case 'tool.error': return 'tool.result'
    default: return null
  }
}

export function sanitizeTurnEventPayload(event: { type: string; [key: string]: unknown }): Record<string, unknown> {
  const skip = new Set(['type', 'sessionId', 'turnId'])
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(event)) {
    if (skip.has(k)) continue
    if (typeof v === 'string' && v.length > TRACE_TRUNCATE_CHARS) {
      result[k] = v.slice(0, TRACE_TRUNCATE_CHARS) + `\n…<truncated, ${v.length - TRACE_TRUNCATE_CHARS} chars omitted>`
      continue
    }
    result[k] = v
  }
  return result
}
