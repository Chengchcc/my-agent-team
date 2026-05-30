import { describe, it, expect, mock } from 'bun:test'
import type { SubAgentDescriptor } from '../../../src/extensions/sub-agent/types'

let runMiniTurnLoop: any
try {
  const mod = require('../../../src/extensions/sub-agent/mini-turn-loop')
  runMiniTurnLoop = mod.runMiniTurnLoop
} catch {
  // Module not yet created — tests will be skipped at runtime
}

function makeDesc(overrides?: Partial<SubAgentDescriptor>): SubAgentDescriptor {
  return {
    type: 'test',
    description: 'test sub-agent',
    systemPrompt: 'You are a test sub-agent.',
    allowedToolNames: ['read', 'grep'],
    maxRounds: 3,
    maxTokensPerCall: 1000,
    source: 'builtin',
    ...overrides,
  }
}

const noopLog = () => {}

describe('runMiniTurnLoop', () => {
  it('returns finalText when LLM responds without tool calls', async () => {
    const chatComplete = mock(async () => ({
      content: 'task completed',
      toolCalls: undefined,
      finishReason: 'stop' as const,
      usage: { input: 10, output: 5 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'find X',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finalText).toBe('task completed')
    expect(result.finishReason).toBe('stop')
    expect(result.rounds).toBe(1)
    expect(chatComplete).toHaveBeenCalledTimes(1)
  })

  it('respects maxRounds and returns max_rounds_reached error', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: [{ id: 't1', name: 'read', arguments: { file: 'x' } }],
      finishReason: 'tool_calls' as const,
      usage: { input: 10, output: 5 },
    }))
    const dispatchTool = mock(async () => ({ success: true, result: 'file content' }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 2 }),
      userPrompt: 'find X',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('max_rounds')
    expect(result.finalText).toContain('max_rounds_reached')
    expect(result.finalText).toContain('rounds="2"')
    expect(chatComplete).toHaveBeenCalledTimes(2)
  })

  it('classifies llm_failed when chatComplete throws', async () => {
    const chatComplete = mock(async () => {
      throw new Error('rate limit exceeded: 429')
    })

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('error')
    expect(result.finalText).toContain('llm_failed')
    expect(result.finalText).toContain('rate_limit')
  })

  it('returns response_truncated on finishReason=length', async () => {
    const chatComplete = mock(async () => ({
      content: 'partial response...',
      toolCalls: undefined,
      finishReason: 'length' as const,
      usage: { input: 10, output: 5 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('length')
    expect(result.finalText).toContain('response_truncated')
    expect(result.finalText).toContain('partial response')
  })

  it('returns response_filtered on content_filter', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: undefined,
      finishReason: 'content_filter' as const,
      usage: { input: 10, output: 0 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finalText).toContain('response_filtered')
  })

  it('bails with tool_unavailable on TOOL_NOT_ALLOWED', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: [{ id: 't1', name: 'bash', arguments: { cmd: 'rm' } }],
      finishReason: 'tool_calls' as const,
      usage: { input: 10, output: 5 },
    }))
    const dispatchTool = mock(async () => ({
      success: false,
      error: { code: 'TOOL_NOT_ALLOWED' as const, message: 'not allowed' },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('tool_unavailable')
    expect(result.finalText).toContain('tool_unavailable')
    expect(result.finalText).toContain('bash')
  })

  it('injects TOOL_EXEC_FAIL as tool result for first 2 failures, then recovers', async () => {
    let callCount = 0
    const chatComplete = mock(async () => {
      callCount++
      if (callCount === 3) {
        return { content: 'recovered!', toolCalls: undefined, finishReason: 'stop' as const, usage: { input: 10, output: 5 } }
      }
      return {
        content: '',
        toolCalls: [{ id: `t${callCount}`, name: 'read', arguments: { file: 'x' } }],
        finishReason: 'tool_calls' as const,
        usage: { input: 10, output: 5 },
      }
    })
    const dispatchTool = mock(async () => ({
      success: false,
      error: { code: 'TOOL_EXEC_FAIL' as const, message: 'read failed' },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 10 }),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('stop')
    expect(result.finalText).toBe('recovered!')
    // 3 rounds: 2 failures injected, 1 recovery
    expect(chatComplete).toHaveBeenCalledTimes(3)
  })

  it('I-7: terminates after 2 consecutive empty rounds', async () => {
    let callCount = 0
    const chatComplete = mock(async () => {
      callCount++
      return { content: '', toolCalls: undefined, finishReason: 'stop' as const, usage: { input: 1, output: 0 } }
    })

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 10 }),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: '' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('empty_rounds')
    expect(callCount).toBe(2)
    expect(result.finalText).toContain('empty_rounds')
  })
})
