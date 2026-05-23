import { describe, it, expect } from 'bun:test'
import { AnthropicNativeDecoder } from '../../../../src/infrastructure/llm/adapters/thinking/anthropic-native'
import { ReasoningContentDecoder } from '../../../../src/infrastructure/llm/adapters/thinking/reasoning-content'

describe('AnthropicNativeDecoder', () => {
  it('decodes thinking block', () => {
    const decoder = new AnthropicNativeDecoder()
    const block = { type: 'thinking', thinking: 'Let me think about this...' }
    const result = decoder.decodeResponseBlock(block)
    expect(result).toBeTruthy()
    expect(result!.type).toBe('thinking')
  })

  it('decodes redacted thinking', () => {
    const decoder = new AnthropicNativeDecoder()
    const block = { type: 'redacted_thinking', data: 'encrypted...' }
    const result = decoder.decodeResponseBlock(block)
    expect(result).toBeTruthy()
    expect(result!.type).toBe('redacted_thinking')
  })

  it('returns null for text block', () => {
    const decoder = new AnthropicNativeDecoder()
    const block = { type: 'text', text: 'Hi' }
    const result = decoder.decodeResponseBlock(block)
    expect(result).toBeNull()
  })
})

describe('ReasoningContentDecoder', () => {
  it('decodes reasoning content block', () => {
    const decoder = new ReasoningContentDecoder()
    const block = { type: 'reasoning', reasoning: 'Analysis...' }
    const result = decoder.decodeResponseBlock(block)
    expect(result).toBeTruthy()
    expect(result!.type).toBe('thinking')
  })
})
