import { describe, it, expect } from 'bun:test'
import { buildExtractPrompt } from '../../../src/extensions/memory/extract-prompt'
import type { TraceRun } from '../../../src/domain/trace/types'

function mockRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    startTime: 1000,
    endTime: 2000,
    model: 'claude-opus-4-7',
    turns: [
      { turnIndex: 1, userMessage: 'Hello, use ripgrep for searching', modelResponse: { text: 'Sure, I will use rg', toolCalls: [{ name: 'bash', arguments: {} }] }, toolExecutions: [] },
      { turnIndex: 2, userMessage: 'Find the config file', modelResponse: { text: 'Found it at /etc/config.yaml', toolCalls: [] }, toolExecutions: [] },
      { turnIndex: 3, userMessage: 'Thanks!', modelResponse: { text: 'You are welcome', toolCalls: [] }, toolExecutions: [] },
    ],
    summary: {
      totalTurns: 3, totalToolCalls: 1, totalErrors: 0,
      totalTokens: { input: 100, output: 200 },
      outcome: 'completed',
    },
    ...overrides,
  }
}

describe('buildExtractPrompt', () => {
  it('renders user messages and agent responses in user content', () => {
    const result = buildExtractPrompt({ runId: 'r1', run: mockRun() })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.role).toBe('system')
    expect(result.messages[1]!.role).toBe('user')
    const userContent = result.messages[1]!.content
    expect(userContent).toContain('User: Hello, use ripgrep for searching')
    expect(userContent).toContain('Agent: Sure, I will use rg')
    expect(userContent).toContain('User: Find the config file')
    expect(userContent).toContain('Agent: Found it at /etc/config.yaml')
    expect(userContent).toContain('Tools: bash')
  })

  it('caps turns at 20', () => {
    const manyTurns = Array.from({ length: 30 }, (_, i) => ({
      turnIndex: i + 1,
      userMessage: `msg ${i + 1}`,
      modelResponse: { text: `resp ${i + 1}`, toolCalls: [] },
      toolExecutions: [],
    }))
    const run = mockRun({ turns: manyTurns, summary: { totalTurns: 30, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' } })
    const result = buildExtractPrompt({ runId: 'r1', run })
    const userContent = result.messages[1]!.content
    expect(userContent).toContain('--- Turn 11 ---')
    expect(userContent).toContain('--- Turn 30 ---')
    expect(userContent).not.toContain('--- Turn 1 ---')
  })

  it('outputs maxTokens=800', () => {
    const result = buildExtractPrompt({ runId: 'r1', run: mockRun() })
    expect(result.maxTokens).toBe(800)
  })
})
