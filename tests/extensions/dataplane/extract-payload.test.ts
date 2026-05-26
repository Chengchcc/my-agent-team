import { describe, it, expect } from 'bun:test'
import { extractPayload } from '../../../src/extensions/dataplane/extract-payload'

describe('extractPayload', () => {
  it('returns inner payload + envelope-level sessionId/turnId when envelope present', () => {
    const env = { type: 'x', version: 1, ts: 0, sessionId: 'S', turnId: 'T', payload: { a: 1 } }
    expect(extractPayload(env)).toEqual({ payload: { a: 1 }, sessionId: 'S', turnId: 'T' })
  })

  it('FALLS BACK to inner sessionId/turnId when envelope-level is missing', () => {
    // This is the bug-trigger case: ContractBus emit without opts produces such an envelope.
    const env = { type: 'x', version: 1, ts: 0, payload: { sessionId: 'S', turnId: 'T', delta: 'd' } }
    expect(extractPayload(env)).toEqual({
      payload: { sessionId: 'S', turnId: 'T', delta: 'd' },
      sessionId: 'S',
      turnId: 'T',
    })
  })

  it('handles non-envelope raw payloads', () => {
    const raw = { sessionId: 'S', delta: 'd' }
    expect(extractPayload(raw)).toEqual({ payload: raw, sessionId: 'S', turnId: undefined })
  })
})
