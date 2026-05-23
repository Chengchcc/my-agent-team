import { describe, it, expect } from 'bun:test'
import { evaluateReviewPolicy, type PolicyState } from '../../../src/extensions/evolution/policy'

function freshState(): PolicyState {
  return { turnsSinceReview: 0, errorBurst: [], skillRunsSeen: {} }
}

function mkCompleted(opts: Record<string, unknown> = {}) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    usage: { input: 100, output: 200 },
    toolCallCount: 0, toolErrorCount: 0, activatedSkills: [],
    ...opts,
  } as Parameters<typeof evaluateReviewPolicy>[0]
}

function mkFailed(toolErrorCount = 1) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    outcome: 'error' as const, stage: 'llm_stream', reason: 'test',
    toolErrorCount,
  } as Parameters<typeof evaluateReviewPolicy>[0]
}

describe('evaluateReviewPolicy', () => {
  it('returns skip for normal turns below threshold', () => {
    const s = freshState(); s.turnsSinceReview = 5
    expect(evaluateReviewPolicy(mkCompleted(), s).kind).toBe('skip')
  })
  it('returns tier0 after MIN_TURNS_BETWEEN_REVIEWS', () => {
    const s = freshState(); s.turnsSinceReview = 9
    expect(evaluateReviewPolicy(mkCompleted(), s).kind).toBe('tier0')
  })
  it('returns tier0 on error burst (3 fails within window)', () => {
    const s = freshState()
    evaluateReviewPolicy(mkFailed(), s)
    evaluateReviewPolicy(mkFailed(), s)
    expect(evaluateReviewPolicy(mkFailed(), s).kind).toBe('tier0')
  })
  it('returns tier2 when skill activation reaches threshold', () => {
    const s = freshState(); s.skillRunsSeen['bash'] = 19
    const result = evaluateReviewPolicy(mkCompleted({ activatedSkills: ['bash'] }), s)
    expect(result.kind).toBe('tier2')
  })
  it('skip on single failed turn (not burst)', () => {
    expect(evaluateReviewPolicy(mkFailed(), freshState()).kind).toBe('skip')
  })
  it('resets turnsSinceReview after trigger', () => {
    const s = freshState(); s.turnsSinceReview = 9
    evaluateReviewPolicy(mkCompleted(), s)
    expect(s.turnsSinceReview).toBe(0)
  })
})
