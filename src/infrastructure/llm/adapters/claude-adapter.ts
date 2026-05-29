import type { ProviderAdapter } from '../../../application/ports/provider-adapter'
import type {
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from '../../../application/ports/provider'
import type { ThinkingDecoder } from './thinking/types'
import { AnthropicNativeDecoder } from './thinking/anthropic-native'
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '../../../application/constants/llm'

// ── Message conversion ──

interface LlmMessage {
  role: string
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; name: string; arguments: unknown }>
  isError?: boolean
}

function extractSystemPrompt(messages: readonly LlmMessage[]): string | undefined {
  return messages.find((m) => m.role === 'system')?.content
}

function convertToClaudeMessages(
  messages: readonly LlmMessage[],
): Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = []
  let pendingToolResults: Array<Record<string, unknown>> = []

  function flushToolResults(): void {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content ?? '',
        ...(m.isError ? { is_error: true } : {}),
      })
      continue
    }
    flushToolResults()

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: Array<Record<string, unknown>> = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
      }
      out.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'system') {
      // Already extracted as top-level system prompt
      continue
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  flushToolResults()
  return out
}

// ── Tool conversion ──

function toAnthropicTools(tools: ChatRequest['tools']): Array<Record<string, unknown>> {
  if (!tools) return []
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

// ── Adapter ──

export class ClaudeAdapter implements ProviderAdapter {
  private thinkingDecoder: ThinkingDecoder | null
  private currentToolId = ''
  private currentToolName = ''

  constructor(opts?: { thinkingBudgetTokens?: number }) {
    if (opts?.thinkingBudgetTokens != null && opts.thinkingBudgetTokens > 0) {
      this.thinkingDecoder = new AnthropicNativeDecoder()
    } else {
      this.thinkingDecoder = null
    }
  }

  toChatWire(req: ChatRequest, opts: { stream: boolean }): unknown {
    const claudeMessages = convertToClaudeMessages(req.messages as readonly LlmMessage[])
    const system =
      req.systemPrompt ?? extractSystemPrompt(req.messages as readonly LlmMessage[])

    const body: Record<string, unknown> = {
      model: req.model ?? 'claude-sonnet-4-5-20250514',
      messages: claudeMessages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      stream: opts.stream,
    }

    if (system) {
      body.system = system
    }

    if (this.thinkingDecoder) {
      body.thinking = { type: 'enabled', budget_tokens: 1024 }
      body.temperature = 1
    }

    const tools = toAnthropicTools(req.tools)
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = { type: 'auto', disable_parallel_tool_use: false }
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

  fromChatStreamChunk(raw: unknown): ChatResponseChunk | null {
    if (typeof raw !== 'string') return null

    let event: { type: string; [key: string]: unknown }
    try {
      event = JSON.parse(raw) as { type: string; [key: string]: unknown }
    } catch {
      return null
    }

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          this.currentToolId = (block.id as string) ?? ''
          this.currentToolName = (block.name as string) ?? ''
        }
        return null
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          return { type: 'text', delta: delta.text as string }
        }
        if (delta?.type === 'input_json_delta') {
          return {
            type: 'tool_call_start',
            toolCall: {
              id: this.currentToolId,
              name: this.currentToolName,
              arguments: (delta.partial_json as string) ?? '',
            },
          }
        }
        if (delta?.type === 'thinking_delta') {
          return null
        }
        return null
      }
      case 'content_block_stop':
        this.currentToolId = ''
        this.currentToolName = ''
        return null
      case 'message_start':
      case 'message_delta':
        return null
      case 'message_stop':
        return { type: 'done' }
      default:
        return null
    }
  }

  fromChatResponse(raw: unknown): ChatResponse {
    const msg = raw as {
      id: string
      model: string
      usage: { input_tokens: number; output_tokens: number }
      stop_reason?: string
      content: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
    }

    const textBlocks = msg.content.filter((b) => b.type === 'text')
    const content = textBlocks.map((b) => b.text ?? '').join('')

    const toolUseBlocks = msg.content.filter((b) => b.type === 'tool_use')
    const toolCalls = toolUseBlocks.map((b) => ({
      id: b.id ?? '',
      name: b.name ?? '',
      arguments: b.input ?? {},
    }))

    const finishReason: ChatResponse['finishReason'] =
      msg.stop_reason === 'end_turn' ? 'stop'
      : msg.stop_reason === 'max_tokens' ? 'length'
      : msg.stop_reason === 'tool_use' ? 'tool_calls'
      : 'stop'

    return {
      id: msg.id,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
      },
      model: msg.model,
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
