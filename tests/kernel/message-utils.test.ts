import { describe, it, expect } from 'bun:test'
import { extractContent, toLlmMessages } from '../../src/kernel/message-utils'

describe('extractContent', () => {
  it('returns content field when present', () => {
    expect(extractContent({ role: 'user', content: 'hello' })).toBe('hello')
  })

  it('extracts text from blocks when no content field', () => {
    expect(extractContent({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'reply' }],
    })).toBe('reply')
  })

  it('returns empty string for empty blocks', () => {
    expect(extractContent({ role: 'assistant', blocks: [] })).toBe('')
  })

  it('returns empty string for missing both', () => {
    expect(extractContent({ role: 'system' })).toBe('')
  })
})

describe('toLlmMessages', () => {
  it('passes through plain messages', () => {
    const result = toLlmMessages([
      { role: 'user', content: 'hello' },
    ])
    expect(result).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('converts messages with blocks to content format', () => {
    const result = toLlmMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', blocks: [{ type: 'text', text: 'reply' }] },
    ])
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply' },
    ])
  })

  it('converts tool messages to user role for LLM', () => {
    const result = toLlmMessages([
      { role: 'user', content: 'read package.json' },
      { role: 'assistant', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read' }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"name": "my-agent"}' },
      { role: 'assistant', blocks: [{ type: 'text', text: 'The package.json shows...' }] },
    ])
    expect(result).toEqual([
      { role: 'user', content: 'read package.json' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '{"name": "my-agent"}' },
      { role: 'assistant', content: 'The package.json shows...' },
    ])
  })

  it('preserves conversational order: tool_use → tool_result → text', () => {
    const result = toLlmMessages([
      { role: 'user', content: 'read file' },
      { role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { filePath: 'x.ts' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file content here' },
      { role: 'assistant', blocks: [{ type: 'text', text: 'The file says...' }] },
    ])
    expect(result).toEqual([
      { role: 'user', content: 'read file' },
      { role: 'assistant', content: '' },                                     // tool_use → empty content (no text block)
      { role: 'user', content: 'file content here' },                         // tool result → user message
      { role: 'assistant', content: 'The file says...' },                     // text block
    ])
  })

  it('handles mixed formats', () => {
    const result = toLlmMessages([
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'thanks' },
    ])
    expect(result.every(m => typeof m.content === 'string')).toBe(true)
  })
})
