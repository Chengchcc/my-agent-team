import { describe, it, expect } from 'bun:test'
import { OpenAiAdapter } from '../../../../src/infrastructure/llm/adapters/openai-adapter'
import type { ChatRequest } from '../../../../src/application/ports/provider'

const RECORD_STREAM_CHUNKS = [
  '{"type":"response.created"}',
  '{"type":"response.in_progress"}',
  '{"type":"response.output_text.delta","delta":"Hello"}',
  '{"type":"response.output_text.delta","delta":" world"}',
  '{"type":"response.completed"}',
]

const RECORD_COMPLETE_RESPONSE = {
  id: 'resp_1',
  model: 'gpt-5',
  usage: { input_tokens: 10, output_tokens: 5 },
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] },
  ],
}

describe('OpenAiAdapter', () => {
  it('toChatWire builds valid request body', () => {
    const adapter = new OpenAiAdapter()
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'Hi' }],
      systemPrompt: 'Be helpful',
      maxTokens: 500,
    }
    const wire = adapter.toChatWire(req, { stream: true }) as Record<string, unknown>
    expect(wire.model).toBe('gpt-5')
    expect(wire.max_output_tokens).toBe(500)
    expect(wire.stream).toBe(true)
    expect(Array.isArray(wire.messages)).toBe(true)
    const msgs = wire.messages as Array<{ role: string; content: string }>
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe('Be helpful')
  })

  it('fromChatStreamChunk extracts text deltas', () => {
    const adapter = new OpenAiAdapter()
    const chunks = RECORD_STREAM_CHUNKS
      .map((raw) => adapter.fromChatStreamChunk(raw))
      .filter((c) => c !== null)

    const textDeltas = chunks.filter((c) => c!.type === 'text')
    expect(textDeltas.length).toBe(2)
    expect(textDeltas[0]!.delta).toBe('Hello')
    expect(textDeltas[1]!.delta).toBe(' world')
  })

  it('fromChatResponse parses complete response', () => {
    const adapter = new OpenAiAdapter()
    const resp = adapter.fromChatResponse(RECORD_COMPLETE_RESPONSE)
    expect(resp.content).toBe('Hello world')
    expect(resp.usage.input).toBe(10)
  })

  it('fromChatStreamChunk returns null for bookkeeping', () => {
    const adapter = new OpenAiAdapter()
    expect(adapter.fromChatStreamChunk('{"type":"response.created"}')).toBeNull()
    expect(adapter.fromChatStreamChunk('{"type":"response.in_progress"}')).toBeNull()
  })

  it('fromChatStreamChunk returns null for invalid data', () => {
    const adapter = new OpenAiAdapter()
    expect(adapter.fromChatStreamChunk('invalid')).toBeNull()
    expect(adapter.fromChatStreamChunk('')).toBeNull()
  })
})
