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
    let pendingInput = 0
    let pendingOutput = 0

    for await (const sseEvent of parseSSE(resp.body!)) {
      const rawStr = sseEvent.data as string

      // Track usage from raw SSE events before adapter parsing
      try {
        const raw = JSON.parse(rawStr) as { type: string; message?: { usage?: { input_tokens: number } }; usage?: { output_tokens: number } }
        if (raw.type === 'message_start') {
          pendingInput = raw.message?.usage?.input_tokens ?? 0
        } else if (raw.type === 'message_delta') {
          pendingOutput = raw.usage?.output_tokens ?? pendingOutput
        }
      } catch { /* not JSON, skip */ }

      const chunks = this.adapter.fromChatStreamChunk(rawStr)
      if (chunks === null) continue

      for (const chunk of chunks) {
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
          // Emit accumulated usage before done
          if (pendingInput > 0 || pendingOutput > 0) {
            yield { type: 'usage', usage: { input: pendingInput, output: pendingOutput } }
          }
          yield chunk
          continue
        }

        yield chunk
      }
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
