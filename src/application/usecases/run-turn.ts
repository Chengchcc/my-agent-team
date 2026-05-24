import { runTurn } from '../../domain/turn-runner'
import { toLlmMessages } from '../../kernel/message-utils'
import { appendHistory } from './append-history'
import type { SessionStore } from '../ports/session-store'
import type { ProviderChat } from '../ports/provider'
import { createEvent } from '../contracts';
import type { HistoryRecordV1 } from '../contracts';
import { asContractBus } from '../event-bus/contract-bus';
import type { ToolContext } from '../ports/tool-context';
import { createToolSink, flushSink } from '../dispatch'
import type { ToolSinkInternal } from '../ports/tool-sink'
import type { SessionHistoryPort } from '../ports/session-history'
import { approxTokens, COMPACT_AUTO_THRESHOLD_TOKENS, COMPACT_KEEP_RECENT } from '../constants/compact'
import { compactSessionUsecase, type Compactor } from './compact-session'
import type {
  ToolCallRecord, ToolDescriptor, TurnFailureStage,
} from '../../domain/turn-runner.types'

const DEFAULT_MAX_TURN_ITERATIONS = 10

// ── Ports consumed by the usecase ──────────────────────────────────────────

export interface BusPort {
  emit(type: string, payload: unknown): void
}

export interface LoggerPort {
  info(domain: string, message: string): void
  warn(domain: string, message: string): void
  error(domain: string, message: string): void
}

export interface RunTurnUsecaseDeps {
  provider: ProviderChat
  hooks: { dispatch<T = unknown>(name: string, ...args: unknown[]): Promise<T> }
  sessionStore: SessionStore
  history: SessionHistoryPort
  bus: BusPort
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

// ── Helper: emit turn.failed via bus ───────────────────────────────────────

function emitFailed(
  bus: BusPort,
  sessionId: string,
  turnId: string,
  stage: TurnFailureStage,
  err: Error,
  toolErrorCount = 0,
): void {
  asContractBus(bus).emit(createEvent('turn.failed', {
    sessionId,
    turnId,
    runId: turnId,
    outcome: 'error',
    stage,
    reason: err.message,
    toolErrorCount,
  }, { sessionId, turnId }))
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

export async function runTurnUsecase(
  input: RunTurnInput,
  deps: RunTurnUsecaseDeps,
): Promise<{ usage: { input: number; output: number }; success: boolean; finalText?: string }> {
  const { sessionId, turnId, userInput } = input
  const { provider, hooks, history, bus, logger } = deps
  const basePrompt = deps.basePrompt ?? 'You are a helpful AI assistant.'

  // Phase 1: load history (or use initialMessages for ephemeral sessions)
  const historyMsgs = input.initialMessages
    ? [...input.initialMessages]
    : history.get(sessionId)

  // Phase 1b: auto-compact safety net
  await autoCompactIfNeeded(input, deps, historyMsgs)

  // Phase 2: transformPrompt hook (includes history for memory recall)
  const promptR = await safeDispatch<{ system: string; messages: Array<{ role: string; content: string }> }>(
    hooks, 'transformPrompt', {
      system: basePrompt,
      messages: [...historyMsgs, { role: 'user', content: userInput }],
    },
  )
  if (!promptR.ok) {
    emitFailed(bus, sessionId, turnId, 'transformPrompt', promptR.err)
    logger.warn('turn', `transformPrompt failed: ${promptR.err.message}`)
    return { usage: { input: 0, output: 0 }, success: false }
  }

  // Rebuild messages with transformed prompt (history goes after transform output)
  const finalMessages = toLlmMessages([
    { role: 'system', content: promptR.value.system },
    ...promptR.value.messages,
  ])

  // Phase 3: resolveTools hook
  const toolsR = await safeDispatch<ToolDescriptor[]>(hooks, 'resolveTools', [])
  if (!toolsR.ok) {
    emitFailed(bus, sessionId, turnId, 'resolveTools', toolsR.err)
    logger.warn('turn', `resolveTools failed: ${toolsR.err.message}`)
    return { usage: { input: 0, output: 0 }, success: false }
  }

  // If allowedToolNames is set (sub-agent), filter the resolved tools
  const filteredTools = input.allowedToolNames
    ? toolsR.value.filter(t => input.allowedToolNames!.includes(t.name))
    : toolsR.value

  // Phase 4: prepare per-turn abort controller
  const controller = new AbortController()
  deps.sessionAbort.register(sessionId, controller)
  const baseEnv = { cwd: deps.agentDir }

  // Phase 5: drive turn-runner generator
  const collectedToolCalls: ToolCallRecord[] = []
  let toolErrorCount = 0
  let toolCallCount = 0
  let finalText = ''
  let totalUsage = { input: 0, output: 0 }

  try {
    for await (const event of runTurn({
      sessionId, turnId,
      messages: finalMessages,
      tools: filteredTools,
      provider,
      hooks: {
        onToolCall: async (call) => {
          const sink = createToolSink()
          const perCallCtx: ToolContext = {
            signal: controller.signal,
            environment: baseEnv,
            sink,
            sessionId,
            turnId,
          }
          try {
            const result = await hooks.dispatch('onToolCall', call, perCallCtx)
            flushSink(sink as ToolSinkInternal, bus, sessionId)
            return result
          } catch (err) {
            // Failed tool: drop all collected effects (no flush)
            throw err
          }
        },
      },
      maxIterations: DEFAULT_MAX_TURN_ITERATIONS,
      abortSignal: controller.signal,
      parallelTools: input.parallelTools ?? false,
      eventOrder: input.eventOrder ?? 'submission',
      maxOutputTokens: input.maxOutputTokens,
    })) {
      bus.emit(event.type, event)

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
          asContractBus(bus).emit(createEvent('turn.failed', {
            sessionId,
            turnId,
            runId: turnId,
            outcome: 'error',
            stage: event.stage,
            reason: event.err.message,
            toolErrorCount,
          }, { sessionId, turnId }))
          logger.warn('turn', `Turn ${turnId} failed at ${event.stage}: ${event.err.message}`)
          return { usage: totalUsage, success: false }
        default:
          break
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    emitFailed(bus, sessionId, turnId, 'usecase_internal', e, toolErrorCount)
    return { usage: totalUsage, success: false }
  } finally {
    deps.sessionAbort.unregister(sessionId)
  }

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

  // Phase 7: onTurnEnd hook
  const endR = await safeDispatch<void>(hooks, 'onTurnEnd', {
    sessionId, turnId, usage: totalUsage, finalMessage: finalText,
  })
  if (!endR.ok) {
    emitFailed(bus, sessionId, turnId, 'onTurnEnd', endR.err)
    logger.warn('turn', `onTurnEnd hook failed: ${endR.err.message}`)
  }

  asContractBus(bus).emit(createEvent('turn.completed', {
    sessionId,
    turnId,
    runId: turnId,
    usage: { input: totalUsage.input, output: totalUsage.output },
    toolCallCount,
    toolErrorCount,
    activatedSkills: [],
  }, { sessionId, turnId }))

  return { usage: totalUsage, success: true, finalText }
}

// ── Shared glue: build usecase deps from kernel-like context ──────────────

export function buildRunTurnDeps(ctx: {
  extensions: { get<T>(name: string): T }
  hooks: { dispatch(name: string, ...args: unknown[]): Promise<unknown> }
  bus: { emit(event: string, payload: unknown): void }
  logger: { info(d: string, m: string): void; warn(d: string, m: string): void; error(d: string, m: string): void }
  agentDir: string
}): RunTurnUsecaseDeps {
  return {
    provider: ctx.extensions.get<ProviderChat>('provider.llm'),
    hooks: { dispatch: ctx.hooks.dispatch.bind(ctx.hooks) as <T>(n: string, ...a: unknown[]) => Promise<T> },
    sessionStore: ctx.extensions.get<SessionStore>('session.store'),
    history: ctx.extensions.get<SessionHistoryPort>('session.history'),
    bus: ctx.bus as unknown as BusPort,
    logger: ctx.logger as LoggerPort,
    agentDir: ctx.agentDir,
    sessionAbort: ctx.extensions.get<RunTurnUsecaseDeps['sessionAbort']>('session.abort'),
    compactor: ctx.extensions.get<Compactor>('session.compactor'),
  }
}
