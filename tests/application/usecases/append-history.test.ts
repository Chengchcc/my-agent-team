import { describe, it, expect } from 'bun:test'
import { appendHistory } from '../../../src/application/usecases/append-history'

describe('appendHistory', () => {
  it('produces user + assistant pair for text-only turn', () => {
    const result = appendHistory({
      userInput: 'hello',
      toolCalls: [],
      finalText: 'Hi there!',
    })

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(result[0].id).toBeDefined()
    expect(result[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Hi there!' }],
    })
  })

  it('produces correct sequence for tool-call turn', () => {
    const result = appendHistory({
      userInput: 'read file',
      toolCalls: [
        { id: 'tc1', name: 'read', arguments: { path: '/f' }, resultText: 'contents' },
      ],
      finalText: 'The file says: contents',
    })

    // Order: user → assistant(tool_use) → tool(result) → assistant(text)
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ role: 'user' })
    expect(result[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'tc1', name: 'read', input: { path: '/f' } }],
    })
    expect(result[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'tc1',
      name: 'read',
      content: 'contents',
    })
    expect(result[3]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The file says: contents' }],
    })
  })

  it('handles multiple tool calls', () => {
    const result = appendHistory({
      userInput: 'do things',
      toolCalls: [
        { id: 't1', name: 'read', arguments: {}, resultText: 'a' },
        { id: 't2', name: 'write', arguments: {}, resultText: 'ok' },
      ],
      finalText: 'Done.',
    })

    expect(result).toHaveLength(5) // user, assistant(tool_use), tool1, tool2, assistant(text)
    expect(result[1].blocks).toHaveLength(2)
    expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 't1' })
    expect(result[3]).toMatchObject({ role: 'tool', tool_call_id: 't2' })
  })

  it('omits final assistant message when finalText is empty after tools', () => {
    const result = appendHistory({
      userInput: 'go',
      toolCalls: [{ id: 't1', name: 'echo', arguments: {}, resultText: 'echoed' }],
      finalText: '',
    })

    // user, assistant(tool_use), tool — no final assistant text
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ role: 'tool' })
  })

  it('assigns unique IDs to each entry', () => {
    const result = appendHistory({
      userInput: 'test',
      toolCalls: [],
      finalText: 'ok',
    })

    const ids = result.map(r => r.id).filter(Boolean)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2) // unique
  })
})
