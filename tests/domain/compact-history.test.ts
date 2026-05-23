import { describe, it, expect } from 'bun:test'
import { compactHistory } from '../../src/domain/compact-history'
import type { HistoryRecordV1 } from '../../src/application/contracts'

function msg(ts: number, content = 'x'): HistoryRecordV1 {
  return { kind: 'history.record', version: 1, sessionId: 's1', role: 'user', content, ts }
}

function makeHistory(count: number): HistoryRecordV1[] {
  return Array.from({ length: count }, (_, i) => msg(i, `msg-${i}`))
}

describe('compactHistory', () => {
  it('1: returns no-op when history length is at or below keepRecent threshold', () => {
    const history = makeHistory(4)
    const result = compactHistory({ history, summary: 'irrelevant', keepRecent: 4, sessionId: 's1', now: 100 })
    expect(result.removedCount).toBe(0)
    expect(result.summaryRecord).toBeNull()
    expect(result.newHistory).toBe(history)
  })

  it('2: compacts excess records above keepRecent (5 items, keepRecent=4 → 1 compacted)', () => {
    const history = makeHistory(5)
    const result = compactHistory({ history, summary: 'summarized content', keepRecent: 4, sessionId: 's1', now: 100 })
    expect(result.removedCount).toBe(1)
    expect(result.newHistory.length).toBe(5) // 1 summary + 4 recent
    expect(result.newHistory[0]).toBe(result.summaryRecord)
    expect(result.summaryRecord).not.toBeNull()
  })

  it('3: summary record has correct fields (role=system, synthetic metadata, removedCount)', () => {
    const history = makeHistory(10)
    const result = compactHistory({ history, summary: 'summary text', keepRecent: 5, sessionId: 's1', now: 200 })
    const sr = result.summaryRecord!
    expect(sr.kind).toBe('history.record')
    expect(sr.version).toBe(1)
    expect(sr.sessionId).toBe('s1')
    expect(sr.role).toBe('system')
    expect(sr.content).toContain('[Prior conversation summary (5 msgs compacted)]')
    expect(sr.content).toContain('summary text')
    expect(sr.ts).toBe(200)
    expect(sr.metadata).toEqual({
      synthetic: 'compact',
      removedCount: 5,
      sourceRange: [0, 4],
    })
  })

  it('4: sourceRange metadata equals [firstOlder.ts, lastOlder.ts]', () => {
    const history = [
      msg(10, 'a'),
      msg(20, 'b'),
      msg(30, 'c'),
      msg(40, 'd'),
      msg(50, 'e'),
      msg(60, 'f'),
    ]
    const result = compactHistory({ history, summary: 's', keepRecent: 3, sessionId: 's1', now: 999 })
    const range = result.summaryRecord!.metadata!.sourceRange as number[]
    expect(range[0]).toBe(10)
    expect(range).toEqual([10, 30])
  })

  it('5: now parameter is respected for deterministic timestamp', () => {
    const history = makeHistory(5)
    const result1 = compactHistory({ history, summary: 's', keepRecent: 4, sessionId: 's1', now: 777 })
    const result2 = compactHistory({ history, summary: 's', keepRecent: 4, sessionId: 's1', now: 777 })
    expect(result1.summaryRecord!.ts).toBe(777)
    expect(result1.summaryRecord!.ts).toBe(result2.summaryRecord!.ts)
  })

  it('6: newHistory.length equals keepRecent + 1 when history.length > keepRecent', () => {
    const history = makeHistory(20)
    const result = compactHistory({ history, summary: 's', keepRecent: 7, sessionId: 's1', now: 1 })
    expect(result.newHistory.length).toBe(8) // 7 recent + 1 summary
    expect(result.removedCount).toBe(13)
  })

  it('7: the last keepRecent records in newHistory are the same object references as the input tail', () => {
    const history = makeHistory(10)
    const result = compactHistory({ history, summary: 's', keepRecent: 3, sessionId: 's1', now: 1 })
    // newHistory = [summary, ...recent] where recent = last 3 of input
    const recent = history.slice(history.length - 3)
    expect(result.newHistory[1]).toBe(recent[0])
    expect(result.newHistory[2]).toBe(recent[1])
    expect(result.newHistory[3]).toBe(recent[2])
  })
})
