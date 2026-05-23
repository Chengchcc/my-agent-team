import { describe, it, expect } from 'bun:test'
import { ClaudeAdapter } from '../../../../src/infrastructure/llm/adapters/claude-adapter'
import type { ChatRequest } from '../../../../src/application/ports/provider'

const RECORD_STREAM_CHUNKS = [
  '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250514","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '{"type":"content_block_stop","index":0}',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '{"type":"message_stop"}',
]

const RECORD_COMPLETE_RESPONSE = {
  id: 'msg_1',
  model: 'claude-sonnet-4-5-20250514',
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [{ type: 'text', text: 'Hello world' }],
}

describe('ClaudeAdapter', () => {
  it('toChatWire builds valid request body', () => {
    const adapter = new ClaudeAdapter()
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'Hi' }],
      systemPrompt: 'You are helpful.',
      maxTokens: 1000,
    }
    const wire = adapter.toChatWire(req, { stream: true }) as Record<string, unknown>
    expect(wire.model).toBe('claude-sonnet-4-5-20250514')
    expect(wire.max_tokens).toBe(1000)
    expect(wire.stream).toBe(true)
    expect(wire.system).toBe('You are helpful.')
    expect(Array.isArray(wire.messages)).toBe(true)
  })

  it('fromChatStreamChunk yields text deltas', () => {
    const adapter = new ClaudeAdapter()
    const chunks = RECORD_STREAM_CHUNKS
      .map((raw) => adapter.fromChatStreamChunk(raw))
      .filter((c) => c !== null)

    const textDeltas = chunks.filter((c) => c!.type === 'text')
    expect(textDeltas.length).toBe(2)
    expect(textDeltas[0]!.delta).toBe('Hello')
    expect(textDeltas[1]!.delta).toBe(' world')
  })

  it('fromChatStreamChunk yields done at message_stop', () => {
    const adapter = new ClaudeAdapter()
    const chunks = RECORD_STREAM_CHUNKS
      .map((raw) => adapter.fromChatStreamChunk(raw))
      .filter((c) => c !== null)

    const doneChunks = chunks.filter((c) => c!.type === 'done')
    expect(doneChunks.length).toBe(1)
  })

  it('fromChatStreamChunk returns null for bookkeeping', () => {
    const adapter = new ClaudeAdapter()
    expect(adapter.fromChatStreamChunk('{"type":"message_start","message":{}}')).toBeNull()
    expect(adapter.fromChatStreamChunk('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}')).toBeNull()
  })

  it('fromChatStreamChunk returns null for invalid data', () => {
    const adapter = new ClaudeAdapter()
    expect(adapter.fromChatStreamChunk('not json')).toBeNull()
    expect(adapter.fromChatStreamChunk('')).toBeNull()
    expect(adapter.fromChatStreamChunk(123)).toBeNull()
  })

  it('fromChatResponse parses complete response', () => {
    const adapter = new ClaudeAdapter()
    const resp = adapter.fromChatResponse(RECORD_COMPLETE_RESPONSE)
    expect(resp.id).toBe('msg_1')
    expect(resp.content).toBe('Hello world')
    expect(resp.usage.input).toBe(10)
    expect(resp.usage.output).toBe(5)
  })

  it('fromInvokeResponse delegates to fromChatResponse', () => {
    const adapter = new ClaudeAdapter()
    const resp = adapter.fromInvokeResponse(RECORD_COMPLETE_RESPONSE)
    expect(resp.content).toBe('Hello world')
    expect(resp.usage.input).toBe(10)
  })
})
