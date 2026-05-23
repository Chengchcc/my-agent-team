import { describe, it, expect } from 'bun:test'
import { evaluateExtractPolicy, type PolicyState } from '../../../src/extensions/memory/policy'

function freshState(): PolicyState { return { turnsSinceExtract: 0 } }

function mkCompleted(tokens: { input: number; output: number }) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    usage: tokens, toolCallCount: 0, toolErrorCount: 0, activatedSkills: [],
  } as Parameters<typeof evaluateExtractPolicy>[0]
}

function mkFailed() {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    outcome: 'error' as const, stage: 'llm_stream', reason: 'test', toolErrorCount: 1,
  } as Parameters<typeof evaluateExtractPolicy>[0]
}

describe('evaluateExtractPolicy', () => {
  it('returns skip for low token turns', () => {
    expect(evaluateExtractPolicy(mkCompleted({ input: 0, output: 0 }), freshState()).kind).toBe('skip')
  })
  it('returns extract when tokens >= 800', () => {
    expect(evaluateExtractPolicy(mkCompleted({ input: 400, output: 400 }), freshState()).kind).toBe('extract')
  })
  it('returns extract after FORCE_EXTRACT_INTERVAL', () => {
    const s = freshState(); s.turnsSinceExtract = 4
    expect(evaluateExtractPolicy(mkCompleted({ input: 0, output: 0 }), s).kind).toBe('extract')
  })
  it('skips failed turns', () => {
    expect(evaluateExtractPolicy(mkFailed(), freshState()).kind).toBe('skip')
  })
  it('resets counter after extract', () => {
    const s = freshState(); s.turnsSinceExtract = 4
    evaluateExtractPolicy(mkCompleted({ input: 0, output: 0 }), s)
    expect(s.turnsSinceExtract).toBe(0)
  })
})
