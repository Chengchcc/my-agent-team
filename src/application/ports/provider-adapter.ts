// Port interface for LLM wire-format adapters — pure function contract, zero IO.
// Each vendor (Claude, OpenAI, etc.) provides one adapter implementation.
// Provider classes (IO layer) delegate wire conversion to adapters.

import type {
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from './provider'

// Tool call in response
/** @public — consumed by provider adapter implementations */
export type ToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ProviderAdapter {
  /** Build vendor wire request body for chat (stream or non-stream). */
  toChatWire(req: ChatRequest, opts: { stream: boolean }): unknown

  /** Build vendor wire request body for invoke (always non-stream). */
  toInvokeWire(req: InvokeRequest): unknown

  /** Parse one streaming chunk; return null to skip (heartbeat / unknown event), array of chunks otherwise. */
  fromChatStreamChunk(raw: unknown): ChatResponseChunk[] | null

  /** Parse complete (non-stream) chat response. */
  fromChatResponse(raw: unknown): ChatResponse

  /** Parse invoke response. */
  fromInvokeResponse(raw: unknown): InvokeResponse
}
