// Port interfaces for LLM provider abstraction — zero IO, zero adapter imports.

interface ChatRequest {
  purpose: string                    // mandatory — audit / quota / whitelist
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  model?: string
}

interface ChatResponse {
  id: string
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'  // mandatory
  usage: { input: number; output: number }
  model: string
}

interface ProviderChat {
  stream(req: ChatRequest): AsyncGenerator<ChatResponseChunk>
  complete(req: ChatRequest): Promise<ChatResponse>
}

type ChatResponseChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; toolCall: { id: string; name: string; arguments: string } }
  | { type: 'usage'; usage: { input: number; output: number } }
  | { type: 'done' }

interface InvokeRequest {
  kind: 'internal'
  purpose: string
  parentTurnId: string
  messages: Array<{ role: string; content: string }>
  maxTokens?: number
  model?: string
  signal?: AbortSignal
}

interface InvokeResponse {
  content: string
  usage: { input: number; output: number }
}

interface ProviderInvoke {
  call(req: InvokeRequest): Promise<InvokeResponse>
}

export type {
  ChatRequest,
  ChatResponse,
  ProviderChat,
  ChatResponseChunk,
  InvokeRequest,
  InvokeResponse,
  ProviderInvoke,
}
