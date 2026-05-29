import type {
  ProviderChat,
  ProviderInvoke,
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from '../../application/ports/provider'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { parseSSE } from './shared/parse-sse'
import { normalizeHttpError } from './shared/http-error'

export class ClaudeProvider implements ProviderChat, ProviderInvoke {
  readonly providerId = 'claude' as const
  readonly model: string
  private apiKey: string
  private baseURL: string
  private adapter: ClaudeAdapter

  constructor(opts: {
    apiKey: string
    model?: string
    baseURL?: string
    thinkingBudgetTokens?: number
  }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? 'claude-sonnet-4-5-20250514'
    this.baseURL = opts.baseURL ?? 'https://api.anthropic.com'
    this.adapter = new ClaudeAdapter({ thinkingBudgetTokens: opts.thinkingBudgetTokens })
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatResponseChunk> {
    const wire = this.adapter.toChatWire(req, { stream: true })
    const resp = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(wire),
      signal: req.signal,
    })

    if (!resp.ok) {
      throw await normalizeHttpError(resp, 'claude')
    }

    let currentToolId = ''
    let currentToolName = ''
    let currentToolArgs = ''

    for await (const sseEvent of parseSSE(resp.body!)) {
      const chunk = this.adapter.fromChatStreamChunk(sseEvent.data)
      if (chunk === null) continue

      if (chunk.type === 'tool_call_start') {
        if (chunk.toolCall.name) currentToolName = chunk.toolCall.name
        if (chunk.toolCall.id) currentToolId = chunk.toolCall.id
        currentToolArgs += chunk.toolCall.arguments
        continue
      }

      if (chunk.type === 'done') {
        if (currentToolArgs) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(currentToolArgs) as Record<string, unknown>
          } catch {
            /* keep as string */
          }
          yield {
            type: 'tool_call_start',
            toolCall: {
              id: currentToolId,
              name: currentToolName,
              arguments: JSON.stringify(args),
            },
          }
          currentToolId = ''
          currentToolName = ''
          currentToolArgs = ''
        }
        yield chunk
        continue
      }

      yield chunk
    }
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const wire = this.adapter.toChatWire(req, { stream: false })
    const resp = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(wire),
      signal: req.signal,
    })

    if (!resp.ok) {
      throw await normalizeHttpError(resp, 'claude')
    }

    const json = (await resp.json()) as unknown
    return this.adapter.fromChatResponse(json)
  }

  async call(req: InvokeRequest): Promise<InvokeResponse> {
    const chatReq: ChatRequest = {
      purpose: 'invoke',
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
