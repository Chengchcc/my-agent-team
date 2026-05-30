import type { ProviderAdapter } from '../../../application/ports/provider-adapter'
import type {
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from '../../../application/ports/provider'
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '../../../application/constants/llm'

interface LlmMessage {
  role: string
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; name: string; arguments: unknown }>
  isError?: boolean
}

function toOpenAiMessages(
  messages: readonly LlmMessage[],
  systemPrompt?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt })
  for (const m of messages) {
    const role = m.role === 'system' ? 'system' : m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user'
    const msg: Record<string, unknown> = { role, content: m.content }
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (m.role === 'assistant' && m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function', function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
      }))
    }
    result.push(msg)
  }
  return result
}

function toOpenAiTools(
  tools: ChatRequest['tools'],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export class OpenAiAdapter implements ProviderAdapter {
  toChatWire(req: ChatRequest, opts: { stream: boolean }): unknown {
    const messages = toOpenAiMessages(
      req.messages as readonly LlmMessage[],
      req.systemPrompt,
    )

    const body: Record<string, unknown> = {
      model: req.model ?? 'gpt-5',
      messages,
      max_output_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      stream: opts.stream,
    }

    const tools = toOpenAiTools(req.tools)
    if (tools) {
      body.tools = tools
    }

    return body
  }

  toInvokeWire(req: InvokeRequest): unknown {
    return this.toChatWire(
      {
        purpose: 'internal',
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: req.maxTokens,
        model: req.model,
      },
      { stream: false },
    )
  }

  fromChatStreamChunk(raw: unknown): ChatResponseChunk[] | null {
    if (typeof raw !== 'string') return null

    let event: { type: string; [key: string]: unknown }
    try {
      event = JSON.parse(raw) as { type: string; [key: string]: unknown }
    } catch {
      return null
    }

    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = event.delta as string | undefined
        if (delta) {
          return [{ type: 'text', delta }]
        }
        return null
      }
      case 'response.output_item.done': {
        const item = event.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call') {
          return [{
            type: 'tool_call_start',
            toolCall: {
              id: (item.id as string) ?? '',
              name: (item.name as string) ?? '',
              arguments: JSON.stringify(item.arguments ?? {}),
            },
          }]
        }
        return null
      }
      case 'response.completed': {
        const resp = event.response as { usage?: { input_tokens: number; output_tokens: number } } | undefined
        const chunks: ChatResponseChunk[] = []
        if (resp?.usage) {
          chunks.push({ type: 'usage', usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens } })
        }
        chunks.push({ type: 'done', finishReason: 'stop' })
        return chunks
      }
      case 'response.done':
        return [{ type: 'done', finishReason: 'stop' }]
      case 'response.created':
      case 'response.in_progress':
        return null
      default:
        return null
    }
  }

  fromChatResponse(raw: unknown): ChatResponse {
    const resp = raw as {
      id: string
      model: string
      usage?: { input_tokens: number; output_tokens: number }
      finish_reason?: string
      output: Array<{
        type: string
        content?: Array<{ type: string; text?: string }>
        id?: string
        name?: string
        arguments?: string
      }>
    }

    let content = ''
    const toolCalls: Array<{
      id: string
      name: string
      arguments: Record<string, unknown>
    }> = []

    for (const item of resp.output) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text') {
            content += c.text ?? ''
          }
        }
      } else if (item.type === 'function_call') {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
        } catch {
          /* keep empty */
        }
        toolCalls.push({
          id: item.id ?? '',
          name: item.name ?? '',
          arguments: args,
        })
      }
    }

    const finishReason: ChatResponse['finishReason'] =
      resp.finish_reason === 'length' ? 'length'
      : resp.finish_reason === 'tool_calls' ? 'tool_calls'
      : resp.finish_reason === 'content_filter' ? 'content_filter'
      : 'stop'

    return {
      id: resp.id,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: {
        input: resp.usage?.input_tokens ?? 0,
        output: resp.usage?.output_tokens ?? 0,
      },
      model: resp.model,
    }
  }

  fromInvokeResponse(raw: unknown): InvokeResponse {
    const chatResp = this.fromChatResponse(raw)
    return {
      content: chatResp.content,
      usage: chatResp.usage,
    }
  }
}
