import type {
  ProviderChat,
  ProviderInvoke,
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from '../../application/ports/provider'
import { OpenAiAdapter } from './adapters/openai-adapter'
import { parseSSE } from './shared/parse-sse'
import { normalizeHttpError } from './shared/http-error'

export class OpenAiProvider implements ProviderChat, ProviderInvoke {
  readonly providerId = 'openai' as const
  readonly model: string
  private apiKey: string
  private baseURL: string
  private adapter: OpenAiAdapter

  constructor(opts: {
    apiKey: string
    model?: string
    baseURL?: string
  }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? 'gpt-5'
    this.baseURL = opts.baseURL ?? 'https://api.openai.com'
    this.adapter = new OpenAiAdapter()
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatResponseChunk> {
    const wire = this.adapter.toChatWire(req, { stream: true })
    const resp = await fetch(`${this.baseURL}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(wire),
      signal: req.signal,
    })

    if (!resp.ok) {
      throw await normalizeHttpError(resp, 'openai')
    }

    for await (const sseEvent of parseSSE(resp.body!)) {
      const chunk = this.adapter.fromChatStreamChunk(sseEvent.data)
      if (chunk !== null) yield chunk
    }
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const wire = this.adapter.toChatWire(req, { stream: false })
    const resp = await fetch(`${this.baseURL}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(wire),
      signal: req.signal,
    })

    if (!resp.ok) {
      throw await normalizeHttpError(resp, 'openai')
    }

    const json = (await resp.json()) as unknown
    return this.adapter.fromChatResponse(json)
  }

  async call(req: InvokeRequest): Promise<InvokeResponse> {
    const chatReq: ChatRequest = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: req.maxTokens,
    }
    if (req.model) {
      chatReq.model = req.model
    }
    const resp = await this.complete(chatReq)
    return { content: resp.content, usage: resp.usage }
  }
}
