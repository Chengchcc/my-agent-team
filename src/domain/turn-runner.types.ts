import type { ProviderChat, ChatResponseChunk } from '../application/ports/provider'

// ── LLM message (as consumed by turn-runner) ──

export interface LlmMessage {
  role: string
  content: string
}

// ── Tool descriptor (pre-resolved by usecase) ──

export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
  readonly?: boolean
  conflictKey?: (input: unknown) => string | null
}

// ── Parsed tool call (from provider stream) ──

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

// ── Tool call record with result text (collected by usecase for history) ──

export interface ToolCallRecord {
  id: string
  name: string
  arguments: unknown
  resultText: string
}

// ── Turn failure stage ──

export type TurnFailureStage =
  | 'transformPrompt'
  | 'resolveTools'
  | 'llm_stream'
  | 'onTurnEnd'
  | 'usecase_internal'

// ── Turn event discriminated union (unified schema for domain + bus) ──

export type TurnEvent =
  | { type: 'llm.delta'; sessionId: string; turnId: string; delta: string }
  | { type: 'llm.usage'; sessionId: string; turnId: string; usage: { input: number; output: number } }
  | { type: 'tool.start'; sessionId: string; turnId: string; callId: string; name: string; args: unknown }
  | { type: 'tool.end'; sessionId: string; turnId: string; callId: string; name: string; result: unknown }
  | { type: 'tool.error'; sessionId: string; turnId: string; callId: string; name: string; err: { message: string } }
  | { type: 'turn.completed'; sessionId: string; turnId: string; usage: { input: number; output: number }; finalMessage: string }
  | { type: 'turn.failed'; sessionId: string; turnId: string; stage: TurnFailureStage; err: { message: string } }

// ── Turn runner hooks (narrow — only what the agent loop needs) ──

/**
 * Domain-internal hook contract — distinct from the kernel-level 'onToolCall'
 * hook registered by tool-catalog / permission extensions.
 *
 * The caller (run-turn usecase) wraps this single method around
 * hooks.dispatch('onToolCall', call, perCallCtx) — ctx flows through the
 * usecase closure, NOT through this domain interface.
 */
export interface RunTurnHooks {
  onToolCall(call: ToolCall): Promise<unknown>
}

// ── Turn runner dependencies (pre-built by usecase) ──

export interface RunTurnDeps {
  sessionId: string
  turnId: string
  messages: LlmMessage[]
  tools: ToolDescriptor[]
  provider: ProviderChat
  hooks: RunTurnHooks
  maxIterations?: number
  abortSignal?: AbortSignal
  parentTurnId?: string
  /** Enable wave-based parallel tool dispatch (default false). */
  parallelTools?: boolean
  /** Event yield order for parallel waves (default 'submission'). */
  eventOrder?: 'completion' | 'submission'
  /** Max output tokens passed through to provider (sub-agent). */
  maxOutputTokens?: number
}

// ── Round result (returned by consumeRound sub-generator via yield*) ──

export interface RoundResult {
  assistantText: string
  toolCalls: ToolCall[]
  usage: { input: number; output: number }
}

// ── Re-export provider chunk for consumeRound ──

export type { ChatResponseChunk }
