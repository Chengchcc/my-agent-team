import { runTurn } from '../../domain/turn-runner'
import { toLlmMessages } from '../../kernel/message-utils'
import { appendHistory } from './append-history'
import type { SessionStore } from '../ports/session-store'
import type { ProviderChat } from '../ports/provider'
import type { HistoryRecordV1 } from '../contracts';
import type { ToolContext } from '../ports/tool-context';
import { createToolSink, flushSink } from '../dispatch'
import type { ToolSinkInternal } from '../ports/tool-sink'
import type { SessionHistoryPort } from '../ports/session-history'
import { approxTokens, COMPACT_AUTO_THRESHOLD_TOKENS, COMPACT_KEEP_RECENT, BUDGET_DEFAULT_TOKEN_LIMIT } from '../constants/compact'
import { reactiveCompactCheck } from './budget-guard'
import { compactSessionUsecase, type Compactor } from './compact-session'
import type { ContractBus } from '../event-bus/contract-bus'
import { asContractBus } from '../event-bus/contract-bus'
import type {
  ToolCallRecord, ToolDescriptor,
} from '../../domain/turn-runner.types'
import { createTraceEventFactory } from '../../domain/trace-event'
import { truncateForTrace, TRACE_TRUNCATE_CHARS } from '../../infrastructure/trace/trace-sanitizer'
import { mapTurnEventToTraceKind, sanitizeTurnEventPayload } from '../../infrastructure/trace/trace-event-mapping'
import { emitTraceRequest } from './emit-trace-request'

const DEFAULT_MAX_TURN_ITERATIONS = 10

// ── Ports consumed by the usecase ──────────────────────────────────────────

export interface LoggerPort {
  info(domain: string, message: string, fields?: Record<string, unknown>): void
  warn(domain: string, message: string, fields?: Record<string, unknown>): void
  error(domain: string, message: string, fields?: Record<string, unknown>): void
}

export interface RunTurnUsecaseDeps {
  provider: ProviderChat
  hooks: { dispatch<T = unknown>(name: string, ...args: unknown[]): Promise<T> }
  sessionStore: SessionStore
  history: SessionHistoryPort
  bus: ContractBus
  logger: LoggerPort
  basePrompt?: string
  agentDir: string
  sessionAbort: {
    register(sessionId: string, controller: AbortController): void
    unregister(sessionId: string): void
  }
  compactor: Compactor
}

export interface RunTurnInput {
  sessionId: string
  turnId: string
  userInput: string
  frontendId: string
  parallelTools?: boolean
  eventOrder?: 'completion' | 'submission'
  /** Turn kind — 'normal' (default) or 'sub-agent'. */
  kind?: 'normal' | 'sub-agent'
  /** If set, resolveTools output is filtered to these tool names. */
  allowedToolNames?: ReadonlyArray<string>
  /** Compaction mode — 'auto' (default) or 'disabled'. */
  compaction?: 'auto' | 'disabled'
  /** Pre-populated history for ephemeral sessions (sub-agents). */
  initialMessages?: HistoryRecordV1[]
  /** Max output tokens for the provider call (default: unlimited). */
  maxOutputTokens?: number
  /** Abort signal for early termination (sub-agents cascade parent signal). */
  abortSignal?: AbortSignal
  /** Model context window size for budget ratio calculation (default: 180k). */
  tokenLimit?: number
}

// ── safeDispatch — wraps hook dispatch, returns Result ─────────────────────

type Ok<T> = { ok: true; value: T }
type Err = { ok: false; err: Error }
type DispatchResult<T> = Ok<T> | Err

async function safeDispatch<T>(
  hooks: { dispatch(name: string, ...args: unknown[]): Promise<unknown> },
  name: string,
  ...args: unknown[]
): Promise<DispatchResult<T>> {
  try { return { ok: true, value: await hooks.dispatch(name, ...args) as T } }
  catch (e) { return { ok: false, err: e instanceof Error ? e : new Error(String(e)) } }
}

// ── Helper: emit turn end via onTurnEnd hook ─────────────────────────────────

async function emitTurnEnd(
  hooks: { dispatch(name: string, ...args: unknown[]): Promise<unknown> },
  sessionId: string,
  turnId: string,
  status: 'completed' | 'failed',
  details: {
    usage?: { input: number; output: number }
    toolCallCount?: number
    toolErrorCount?: number
    finalMessage?: string
    error?: { stage: string; reason: string }
    userMessage?: { role: string; content: string }
  },
  logger: { warn(d: string, m: string): void },
): Promise<void> {
  try {
    await hooks.dispatch('onTurnEnd', { sessionId, turnId, status, ...details })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    logger.warn('turn', `onTurnEnd hook failed: ${e.message}`)
  }
}

// ── Helper: serialize tool result to string ────────────────────────────────

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result)
}

// ── Auto-compact helper (extracted to keep usecase under 150 lines) ────────

async function autoCompactIfNeeded(
  input: RunTurnInput,
  deps: RunTurnUsecaseDeps,
  historyMsgs: HistoryRecordV1[],
): Promise<void> {
  const { sessionId } = input
  const { history, bus, compactor, logger } = deps
  if (input.compaction === 'disabled') return
  if (approxTokens(JSON.stringify(historyMsgs)) <= COMPACT_AUTO_THRESHOLD_TOKENS) return
  logger.info('turn', `auto-compact triggered (history ≈ ${approxTokens(JSON.stringify(historyMsgs))} tokens)`)
  const r = await compactSessionUsecase(
    { sessionId, keepRecent: COMPACT_KEEP_RECENT },
    { history, compactor, bus },
  )
  if (r.ok) {
    historyMsgs.length = 0
    historyMsgs.push(...history.get(sessionId))
  } else {
    logger.warn('turn', `auto-compact failed: ${r.reason ?? 'unknown'}, proceeding with full history`)
  }
}

// ── Run turn usecase ──────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function, complexity
export async function runTurnUsecase(
  input: RunTurnInput,
  deps: RunTurnUsecaseDeps,
): Promise<{ usage: { input: number; output: number }; success: boolean; finalText?: string }> {
  const { sessionId, turnId, userInput } = input
  const { provider, hooks, history, bus, logger } = deps
  const basePrompt = deps.basePrompt ?? 'You are a helpful AI assistant.'
  const tokenLimit = input.tokenLimit ?? BUDGET_DEFAULT_TOKEN_LIMIT; const userMsg = { role: 'user' as const, content: userInput }
  const controller = input.abortSignal ? { signal: input.abortSignal, abort: () => {} } : new AbortController()
  if (!input.abortSignal) deps.sessionAbort.register(sessionId, controller as AbortController)
  const historyMsgs = input.initialMessages ? [...input.initialMessages] : history.get(sessionId)
  await autoCompactIfNeeded(input, deps, historyMsgs)
  const promptR = await safeDispatch<{ system: string; messages: Array<{ role: string; content: string }> }>(
    hooks, 'transformPrompt', {
      system: basePrompt,
      messages: [...historyMsgs, { role: 'user', content: userInput }],
      sessionId
    },
  )
  if (!promptR.ok) {
    logger.warn('turn', `transformPrompt failed: ${promptR.err.message}`)
    await emitTurnEnd(hooks, sessionId, turnId, 'failed', { error: { stage: 'transformPrompt', reason: promptR.err.message }, userMessage: userMsg, }, logger)
    return { usage: { input: 0, output: 0 }, success: false }
  }

  const finalMessages = toLlmMessages([
    { role: 'system', content: promptR.value.system },
    ...promptR.value.messages,
  ])
  const toolsR = await safeDispatch<ToolDescriptor[]>(hooks, 'resolveTools', [], sessionId)
  if (!toolsR.ok) {
    logger.warn('turn', `resolveTools failed: ${toolsR.err.message}`)
    await emitTurnEnd(hooks, sessionId, turnId, 'failed', { error: { stage: 'resolveTools', reason: toolsR.err.message } }, logger)
    return { usage: { input: 0, output: 0 }, success: false }
  }

  const resolvedTools = input.allowedToolNames
    ? toolsR.value.filter(t => input.allowedToolNames!.includes(t.name))
    : toolsR.value

  // Central bootstrap tool gate — strip all tools when bootstrap is active
  const isBootstrapActive = promptR.value.system.includes('## Bootstrap Pending')
  const finalTools = isBootstrapActive ? [] : resolvedTools

  // Emit llm.request + optional prompt.snapshot trace events
  const traceFactory = emitTraceRequest(hooks, sessionId, turnId, promptR.value.system, basePrompt, finalMessages, finalTools.map(t => t.name))

  // Emit message.user trace event
  void hooks.dispatch('onTraceEmit', createTraceEventFactory(sessionId).next(turnId, 'message.user', {
    content: truncateForTrace(userInput),
    contentLength: userInput.length,
    truncated: userInput.length > TRACE_TRUNCATE_CHARS,
  }))

  const baseEnv = { cwd: deps.agentDir }; const collectedToolCalls: ToolCallRecord[] = []
  let toolErrorCount = 0, toolCallCount = 0, finalText = ''; let totalUsage = { input: 0, output: 0 }

  try {
    for await (const event of runTurn({
      sessionId, turnId,
      messages: finalMessages,
      tools: finalTools,
      provider,
      hooks: {
        onToolCall: async (call) => {
          const sink = createToolSink()
          const perCallCtx: ToolContext = { signal: controller.signal, environment: baseEnv, sink, sessionId, turnId, callId: call.id }
          try {
            const result = await hooks.dispatch('onToolCall', call, perCallCtx)
            flushSink(sink as ToolSinkInternal, bus, sessionId)
            return result
          } catch (err) { throw err }
        },
      },
      maxIterations: DEFAULT_MAX_TURN_ITERATIONS,
      abortSignal: controller.signal,
      parallelTools: input.parallelTools ?? true,
      eventOrder: input.eventOrder ?? 'submission',
      maxOutputTokens: input.maxOutputTokens,
      logger: { info: (t, m, f) => logger.info(t, m, f), warn: (t, m, f) => logger.warn(t, m, f) },
    })) {
      event.type !== 'turn.completed' && event.type !== 'turn.failed' &&
        void bus.emit(event.type, event, { sessionId, turnId })

      // Bridge runtime turn events to trace persistence
      const traceKind = mapTurnEventToTraceKind(event.type)
      if (traceKind) {
        void hooks.dispatch('onTraceEmit', traceFactory.next(turnId, traceKind, sanitizeTurnEventPayload(event as unknown as { type: string; [key: string]: unknown })))
      }

      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only relevant TurnEvent variants handled
      switch (event.type) {
        case 'tool.end':
          toolCallCount++
          collectedToolCalls.push({
            id: event.callId, name: event.name,
            arguments: event.result,
            resultText: stringifyResult(event.result),
          })
          break
        case 'tool.error':
          toolCallCount++
          toolErrorCount++
          break
        case 'turn.completed':
          finalText = event.finalMessage
          totalUsage = event.usage
          break
        case 'turn.failed':
          logger.warn('turn', `Turn ${turnId} failed at ${event.stage}: ${event.err.message}`)
          await emitTurnEnd(hooks, sessionId, turnId, 'failed', {
            usage: totalUsage, toolCallCount, toolErrorCount,
            error: { stage: event.stage, reason: event.err.message },
            userMessage: userMsg,
          }, logger)
          return { usage: totalUsage, success: false }
        case 'wave.completed': {
          void bus.emit('wave.completed', { sessionId, turnId, waveIndex: event.waveIndex, callsInWave: event.callsInWave, ts: event.ts }, { sessionId, turnId })
          const budgetResult = await reactiveCompactCheck(
            input, deps, historyMsgs, tokenLimit, sessionId, turnId, bus, logger, totalUsage,
            async (stage, reason) => {
              await emitTurnEnd(hooks, sessionId, turnId, 'failed', { error: { stage, reason }, userMessage: userMsg, }, logger)
            },
          )
          if (budgetResult) return budgetResult
          break
        }
        case 'llm.usage':
          void hooks.dispatch('onTraceEmit', traceFactory.next(turnId, 'llm.end', { usage: event.usage }))
          break
        case 'round.completed':
          void hooks.dispatch('onTraceEmit', traceFactory.next(turnId, 'message.assistant', {
            content: truncateForTrace(event.assistantText),
            contentLength: event.assistantText.length,
            truncated: event.assistantText.length > TRACE_TRUNCATE_CHARS,
            usage: event.usage,
            roundIdx: event.roundIdx,
            finishReason: event.finishReason,
            toolCalls: event.toolCalls.map(c => ({
              id: c.id, name: c.name,
              argsSummary: truncateForTrace(JSON.stringify(c.arguments), 1024),
            })),
          }))
          break
        default:
          break
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    await emitTurnEnd(hooks, sessionId, turnId, 'failed', {
      usage: totalUsage, toolCallCount, toolErrorCount,
      error: { stage: 'usecase_internal', reason: e.message },
    }, logger)
    return { usage: totalUsage, success: false }
  } finally {
    deps.sessionAbort.unregister(sessionId)
  }

  // Check if turn was aborted — emit failed instead of completing
  if (controller.signal.aborted) {
    await emitTurnEnd(hooks, sessionId, turnId, 'failed', {
      usage: totalUsage, toolCallCount, toolErrorCount,
      error: { stage: 'aborted', reason: 'turn aborted' },
      userMessage: userMsg,
    }, logger)
    return { usage: totalUsage, success: false }
  }

  // Phase 5b: reactive budget check after turn completes
  const budgetResult = await reactiveCompactCheck(input, deps, historyMsgs, tokenLimit, sessionId, turnId, bus, logger, totalUsage,
    async (stage, reason) => {
      await emitTurnEnd(hooks, sessionId, turnId, 'failed', { error: { stage, reason }, userMessage: userMsg, }, logger)
    },
  )
  if (budgetResult) return budgetResult

  // Phase 6: persist history
  const newEntries = appendHistory({
    sessionId,
    turnId,
    userInput,
    toolCalls: collectedToolCalls,
    finalText,
  })
  try {
    await history.appendBatch(sessionId, newEntries)
  } catch (err) {
    logger.warn('turn', `history appendBatch failed: ${String(err)}`)
  }

  // Phase 7: onTurnEnd hook — single source of truth for turn termination
  await emitTurnEnd(hooks, sessionId, turnId, 'completed', {
    usage: totalUsage,
    toolCallCount,
    toolErrorCount,
    finalMessage: finalText,
    userMessage: userMsg,
  }, logger)

  return { usage: totalUsage, success: true, finalText }
}

// ── Shared glue: build usecase deps from kernel-like context ──────────────

export function buildRunTurnDeps(ctx: {
  extensions: { get(key: string): unknown }
  hooks: { dispatch(name: string, ...args: unknown[]): Promise<unknown> }
  bus: { emit(event: string, payload: unknown): Promise<void> }
  logger: { info(d: string, m: string): void; warn(d: string, m: string): void; error(d: string, m: string): void }
  agentDir: string
}): RunTurnUsecaseDeps {
  return {
    provider: ctx.extensions.get('provider.llm') as RunTurnUsecaseDeps['provider'],
    hooks: { dispatch: ctx.hooks.dispatch.bind(ctx.hooks) as <T>(n: string, ...a: unknown[]) => Promise<T> },
    sessionStore: ctx.extensions.get('session.store') as RunTurnUsecaseDeps['sessionStore'],
    history: ctx.extensions.get('session.history') as RunTurnUsecaseDeps['history'],
    bus: asContractBus(ctx.bus),
    logger: ctx.logger as LoggerPort,
    agentDir: ctx.agentDir,
    sessionAbort: ctx.extensions.get('session.abort') as RunTurnUsecaseDeps['sessionAbort'],
    compactor: ctx.extensions.get('session.compactor') as RunTurnUsecaseDeps['compactor'],
  }
}
