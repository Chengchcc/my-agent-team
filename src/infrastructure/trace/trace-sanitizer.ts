const TRACE_FIELD_MAX = 16_384 // 16 KB per string field
const TRACE_FULL_MODE = !!process.env.MY_AGENT_TRACE_FULL

export function truncateForTrace(s: string, max = TRACE_FIELD_MAX): string {
  if (TRACE_FULL_MODE || s.length <= max) return s
  return s.slice(0, max) + `\n…<truncated, ${s.length - max} chars omitted>`
}

/** @public — reserved for future payload redaction */
export function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = /token|secret|password|key|auth/i
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (sensitiveKeys.test(k)) { result[k] = '[REDACTED]'; continue }
    if (typeof v === 'string') { result[k] = truncateForTrace(v); continue }
    result[k] = v
  }
  return result
}
