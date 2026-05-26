export function extractPayload(raw: unknown): {
  payload: Record<string, unknown>
  sessionId?: string
  turnId?: string
} {
  const r = (raw as Record<string, unknown> | undefined) ?? {}
  // Detect EventEnvelope: { type, version, ts, sessionId, turnId, payload }
  const isEnvelope =
    typeof r.payload === 'object' && r.payload !== null &&
    typeof r.type === 'string' && typeof r.version === 'number'
  const inner = (r.payload ?? {}) as Record<string, unknown>
  return {
    payload: (isEnvelope ? inner : r) as Record<string, unknown>,
    sessionId: (isEnvelope ? (r.sessionId ?? inner.sessionId) : r.sessionId) as string | undefined,
    turnId:    (isEnvelope ? (r.turnId    ?? inner.turnId)    : r.turnId)    as string | undefined,
  }
}
