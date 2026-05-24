import { describe, test, expect } from 'bun:test'
import { compactSessionUsecase } from '../../src/application/usecases/compact-session'
import type { HistoryRecordV1 } from '../../src/application/contracts'
import type { SessionHistoryPort } from '../../src/application/ports/session-history'
import type { Compactor } from '../../src/application/usecases/compact-session'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(id: number, sessionId = 's1'): HistoryRecordV1 {
  return {
    kind: 'history.record',
    version: 1,
    sessionId,
    role: id % 2 === 0 ? 'user' : 'assistant',
    content: `message ${id}`,
    ts: 1000 + id,
  }
}

function makeRecorder() {
  const events: Array<{ type: string; payload: unknown }> = []
  return {
    bus: { emit: (type: string, payload: unknown) => events.push({ type, payload }) },
    events,
  }
}

interface StubHistoryState {
  getCalled: number
  replaceCalled: number
  lastReplaceArgs: [string, HistoryRecordV1[]] | null
}

interface StubHistoryOpts {
  msgs: HistoryRecordV1[]
  replaceThrows?: boolean
}

function makeStubHistory(opts: StubHistoryOpts): {
  history: SessionHistoryPort
  state: StubHistoryState
} {
  const state: StubHistoryState = { getCalled: 0, replaceCalled: 0, lastReplaceArgs: null }
  const history: SessionHistoryPort = {
    get(_sessionId: string) {
      state.getCalled++
      return opts.msgs
    },
    async appendBatch(_sessionId: string, _msgs: HistoryRecordV1[]) {},
    async replace(sessionId: string, msgs: HistoryRecordV1[]) {
      state.replaceCalled++
      state.lastReplaceArgs = [sessionId, msgs]
      if (opts.replaceThrows) throw new Error('replace failed')
    },
  }
  return { history, state }
}

interface StubCompactorState {
  summarizeCalled: number
  lastSummarizeInput: { sessionId: string; messages: HistoryRecordV1[] } | null
}

interface StubCompactorOpts {
  throws?: boolean
  summary?: string
}

function makeStubCompactor(opts: StubCompactorOpts = {}): {
  compactor: Compactor
  state: StubCompactorState
} {
  const state: StubCompactorState = { summarizeCalled: 0, lastSummarizeInput: null }
  const compactor: Compactor = {
    async summarize(input) {
      state.summarizeCalled++
      state.lastSummarizeInput = input
      if (opts.throws) throw new Error('summary failed')
      return { summary: opts.summary ?? 'summary text', usage: { input: 100, output: 50 } }
    },
  }
  return { compactor, state }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('compactSessionUsecase', () => {
  test('below threshold → ok, compactor not called, replace not called, no event', async () => {
    const { events, bus } = makeRecorder()
    const { history, state: hState } = makeStubHistory({ msgs: [makeMsg(1), makeMsg(2)] })
    const { compactor, state: cState } = makeStubCompactor()

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('below_threshold')
    expect(result.removedCount).toBe(0)
    expect(cState.summarizeCalled).toBe(0)
    expect(hState.getCalled).toBe(1)
    expect(hState.replaceCalled).toBe(0)
    expect(events).toHaveLength(0)
  })

  test('happy path → compactor called with olderSlice, replace called with [summary,...tail], bus saw session.compacted event', async () => {
    const { events, bus } = makeRecorder()
    const msgs = Array.from({ length: 6 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs })
    const { compactor, state: cState } = makeStubCompactor({ summary: 'test summary' })

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(true)
    expect(result.removedCount).toBe(2) // 6 msgs - 4 keep = 2 removed
    expect(result.usage.input).toBe(100)
    expect(result.usage.output).toBe(50)

    // Compactor should be called with the older slice (first 2 msgs)
    expect(cState.summarizeCalled).toBe(1)
    expect(cState.lastSummarizeInput!.sessionId).toBe('s1')
    expect(cState.lastSummarizeInput!.messages).toHaveLength(2)
    expect(cState.lastSummarizeInput!.messages[0]!.content).toBe('message 1')
    expect(cState.lastSummarizeInput!.messages[1]!.content).toBe('message 2')

    // Replace should be called with [summaryRecord, ...tail]
    expect(hState.replaceCalled).toBe(1)
    expect(hState.lastReplaceArgs).not.toBeNull()
    expect(hState.lastReplaceArgs![0]).toBe('s1')
    expect(hState.lastReplaceArgs![1]).toHaveLength(5) // 1 summary + 4 recent
    expect(hState.lastReplaceArgs![1][0]!.role).toBe('system')
    expect(hState.lastReplaceArgs![1][0]!.content).toContain('test summary')

    // Bus should have session.compacted event
    const compactEvent = events.find(e => e.type === 'session.compacted')
    expect(compactEvent).toBeDefined()
    const envelope = compactEvent!.payload as Record<string, unknown>
    expect(envelope.type).toBe('session.compacted')
    const payload = envelope.payload as Record<string, unknown>
    expect(payload.sessionId).toBe('s1')
    expect(payload.removedCount).toBe(2)
  })

  test('compactor throws → ok=false, reason=summary_failed, replace not called, no event', async () => {
    const { events, bus } = makeRecorder()
    const msgs = Array.from({ length: 6 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs })
    const { compactor, state: cState } = makeStubCompactor({ throws: true })

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('summary_failed')
    expect(result.removedCount).toBe(0)
    expect(cState.summarizeCalled).toBe(1)
    expect(hState.replaceCalled).toBe(0)
    expect(events).toHaveLength(0)
  })

  test('replace throws → ok=false, reason=replace_failed, no event', async () => {
    const { events, bus } = makeRecorder()
    const msgs = Array.from({ length: 6 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs, replaceThrows: true })
    const { compactor, state: cState } = makeStubCompactor()

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('replace_failed')
    expect(result.removedCount).toBe(0)
    expect(cState.summarizeCalled).toBe(1)
    expect(hState.replaceCalled).toBe(1)
    expect(events).toHaveLength(0)
  })

  test('keepRecent override honored (keepRecent=2, verify cutoff is correct)', async () => {
    const { events, bus } = makeRecorder()
    const msgs = Array.from({ length: 5 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs })
    const { compactor, state: cState } = makeStubCompactor()

    const result = await compactSessionUsecase(
      { sessionId: 's1', keepRecent: 2 },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(true)
    expect(result.removedCount).toBe(3) // 5 msgs - 2 keep = 3 removed

    // Older slice should be first 3 messages
    expect(cState.lastSummarizeInput!.messages).toHaveLength(3)
    expect(cState.lastSummarizeInput!.messages[0]!.content).toBe('message 1')
    expect(cState.lastSummarizeInput!.messages[2]!.content).toBe('message 3')

    // Replace should have 1 summary + 2 recent = 3 total
    expect(hState.lastReplaceArgs![1]).toHaveLength(3)

    // Bus event should reflect the correct count
    const compactEvent = events.find(e => e.type === 'session.compacted')
    expect(compactEvent).toBeDefined()
    const envelope = compactEvent!.payload as Record<string, unknown>
    const payload = envelope.payload as Record<string, unknown>
    expect(payload.removedCount).toBe(3)
  })

  // ── DESIGN.md gap: empty summary, idempotency ──

  test('empty summary string still produces a summary record', async () => {
    const { events, bus } = makeRecorder()
    const msgs = Array.from({ length: 6 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs })
    const { compactor } = makeStubCompactor({ summary: '' })

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(true)
    // Even with empty summary, replace should be called with a synthetic record
    expect(hState.replaceCalled).toBe(1)
    expect(hState.lastReplaceArgs![1]).toHaveLength(5) // 1 summary + 4 recent
    // The summary record should still be a system message
    expect(hState.lastReplaceArgs![1][0]!.role).toBe('system')
    expect(hState.lastReplaceArgs![1][0]!.content).toContain('msgs compacted')
  })

  test('idempotent: second compact on unchanged history below threshold returns below_threshold', async () => {
    // After first compact, history is [summaryRecord, ...recent] (5 msgs, keepRecent=4 → 5 > 4, should compact)
    // But if new history is short enough (e.g. 3 msgs, keepRecent=4), it returns below_threshold
    const { bus } = makeRecorder()
    const msgs = Array.from({ length: 3 }, (_, i) => makeMsg(i + 1))
    const { history, state: hState } = makeStubHistory({ msgs })
    const { compactor, state: cState } = makeStubCompactor()

    const result = await compactSessionUsecase(
      { sessionId: 's1' },
      { history, compactor, bus },
    )

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('below_threshold')
    expect(cState.summarizeCalled).toBe(0)
    expect(hState.replaceCalled).toBe(0)
  })
})
