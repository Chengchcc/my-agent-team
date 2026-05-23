import { describe, it, expect } from 'bun:test'
import { parseHistoryLine } from '../../src/application/contracts'

describe('parseHistoryLine — schema compat', () => {
  it('parses minimal v1 record', () => {
    const line = JSON.stringify({
      kind: 'history.record', version: 1,
      sessionId: 's1', role: 'user', content: 'hello', ts: 100,
    })
    expect(parseHistoryLine(line)).toMatchObject({ role: 'user', content: 'hello', ts: 100 })
  })

  it('rejects malformed json', () => {
    expect(parseHistoryLine('not json')).toBeNull()
  })

  it('rejects wrong kind', () => {
    expect(parseHistoryLine('{"kind":"other","version":1}')).toBeNull()
  })

  it('rejects wrong version', () => {
    expect(parseHistoryLine(JSON.stringify({
      kind: 'history.record', version: 2,
      sessionId: 's', role: 'user', content: 'x', ts: 0,
    }))).toBeNull()
  })

  it('parses record with synthetic compact metadata', () => {
    const line = JSON.stringify({
      kind: 'history.record', version: 1,
      sessionId: 's', role: 'system', content: '[summary]',
      ts: 100,
      metadata: { synthetic: 'compact', removedCount: 5, sourceRange: [1, 10] },
    })
    const r = parseHistoryLine(line)
    expect(r?.metadata?.synthetic).toBe('compact')
  })
})
