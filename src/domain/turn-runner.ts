import type {
  TurnEvent, RunTurnDeps, RoundResult,
  ToolCall, LlmMessage, ChatResponseChunk,
} from './turn-runner.types'
import { partitionWaves } from './wave-scheduler'
import type { ToolConflictMeta } from './wave-scheduler'

const LOOP_DETECT_WINDOW = 5
const LOOP_DETECT_THRESHOLD = 3
const LOG_TRUNCATE_CHARS = 200

// ── Parse tool call arguments from provider chunk ──

function parseToolArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return {} }
  }
  return args ?? {}
}

// ── Consume one LLM stream round, yielding deltas + collecting tool calls ──

async function* consumeRound(
  stream: AsyncIterable<ChatResponseChunk>,
  ids: { sessionId: string; turnId: string },
): AsyncGenerator<TurnEvent, RoundResult, void> {
  let assistantText = ''
  const toolCalls: ToolCall[] = []
  let usage = { input: 0, output: 0 }

  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      assistantText += chunk.delta
      yield { type: 'llm.delta', ...ids, delta: chunk.delta }
    } else if (chunk.type === 'tool_call_start') {
      const tc = chunk.toolCall
      toolCalls.push({ id: tc.id, name: tc.name, arguments: parseToolArgs(tc.arguments) })
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
      yield { type: 'llm.usage', ...ids, usage }
    } else if (chunk.type === 'done') {
      break
    }
  }

  return { assistantText, toolCalls, usage }
}

// ── Turn runner: agent loop as async generator ──

// ── Turn runner: agent loop as async generator ──

// eslint-disable-next-line complexity
export async function* runTurn(deps: RunTurnDeps): AsyncGenerator<TurnEvent, void, void> {
  const { sessionId, turnId, messages, tools, provider, hooks, systemPrompt } = deps
  const max = deps.maxIterations ?? 10

  let currentMessages: LlmMessage[] = [...messages]
  let finalText = ''
  let totalUsage = { input: 0, output: 0 }
  const log = deps.logger
  const startTime = Date.now()
  const sigs: string[] = []

  if (log) log.info('turn-runner', 'turn.start', { sessionId, turnId, historyLen: currentMessages.length })

  try {
    for (let iter = 0; iter < max; iter++) {
      if (deps.abortSignal?.aborted) break
      if (log) log.info('turn-runner', 'round.start', { sessionId, turnId, roundIdx: iter, msgCount: currentMessages.length })
      const round = yield* consumeRound(
        provider.stream({ messages: currentMessages, tools, systemPrompt, signal: deps.abortSignal }),
        { sessionId, turnId },
      )

      totalUsage.input += round.usage.input
      totalUsage.output += round.usage.output

      if (log) log.info('turn-runner', 'round.llm.returned', { sessionId, turnId, roundIdx: iter, textLen: round.assistantText.length, toolCallCount: round.toolCalls.length })

      if (round.assistantText || round.toolCalls.length > 0) {
        if (round.assistantText) finalText += round.assistantText
        currentMessages.push({
          role: 'assistant',
          content: round.assistantText,
          tool_calls: round.toolCalls.length > 0 ? round.toolCalls : undefined,
        })
        yield {
          type: 'round.completed',
          sessionId, turnId,
          roundIdx: iter,
          assistantText: round.assistantText,
          toolCalls: round.toolCalls as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
          usage: round.usage,
          finishReason: round.toolCalls.length > 0 ? 'tool_use' : 'stop',
        }
      } else {
        if (log) {
          log.warn('turn-runner', 'empty.llm.response', {
            sessionId, turnId, roundIdx: iter,
            usageInput: round.usage.input, usageOutput: round.usage.output,
          })
        }
        // Synthetic fallback — never silent
        const synthetic = '(LLM returned an empty response. Please retry.)'
        finalText += synthetic
        currentMessages.push({ role: 'assistant', content: synthetic })
        yield { type: 'llm.delta', sessionId, turnId, delta: synthetic }
        yield {
          type: 'round.completed',
          sessionId, turnId,
          roundIdx: iter,
          assistantText: synthetic,
          toolCalls: [],
          usage: round.usage,
          finishReason: 'empty',
        }
      }

      if (round.toolCalls.length === 0) break
      if (deps.abortSignal?.aborted) break

      const descMap = new Map<string, ToolConflictMeta>()
      for (const t of deps.tools) {
        if (t.readonly !== undefined || t.conflictKey) descMap.set(t.name, { readonly: t.readonly, conflictKey: t.conflictKey })
      }

      const waves = deps.parallelTools
        ? partitionWaves(round.toolCalls, descMap, sessionId)
        : round.toolCalls.map(c => [c])

      for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi]!
        if (deps.abortSignal?.aborted) break

        for (const call of wave) {
          yield { type: 'tool.start', sessionId, turnId, callId: call.id, name: call.name, args: call.arguments }
        }

        // Execute wave and collect results
        const settled = await Promise.allSettled(wave.map(async call => {
          const toolStart = Date.now()
          if (log) log.info('turn-runner', 'tool.invoke', { callId: call.id, name: call.name, argsSample: JSON.stringify(call.arguments).slice(0, LOG_TRUNCATE_CHARS) })
          try {
            const result = await hooks.onToolCall(call)
            const payload = typeof result === 'string' ? result : JSON.stringify(result)
            if (log) log.info('turn-runner', 'tool.done', { callId: call.id, name: call.name, ok: true, durationMs: Date.now() - toolStart, resultLen: payload.length, resultSample: payload.slice(0, LOG_TRUNCATE_CHARS) })
            return { call, ok: true as const, result, payload }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (log) log.info('turn-runner', 'tool.done', { callId: call.id, name: call.name, ok: false, durationMs: Date.now() - toolStart, err: msg })
            return { call, ok: false as const, err: msg, payload: '' }
          }
        }))

        for (const s of settled) {
          if (s.status === 'rejected') { yield { type: 'tool.error', sessionId, turnId, callId: 'unknown', name: 'unknown', err: { message: String(s.reason) } }; continue }
          const r = s.value
          if (r.ok) {
            yield { type: 'tool.end', sessionId, turnId, callId: r.call.id, name: r.call.name, result: r.result }
            currentMessages.push({ role: 'tool', tool_call_id: r.call.id, content: r.payload })
          } else {
            yield { type: 'tool.error', sessionId, turnId, callId: r.call.id, name: r.call.name, err: { message: r.err } }
            currentMessages.push({ role: 'tool', tool_call_id: r.call.id, content: r.err, isError: true })
          }
          // Dead loop detection
          const sig = `${r.call.name}:${JSON.stringify(r.call.arguments)}`
          sigs.push(sig)
          if (sigs.length > LOOP_DETECT_WINDOW) sigs.shift()
          const sameCount = sigs.filter(s => s === sig).length
          if (sameCount >= LOOP_DETECT_THRESHOLD && log) {
            log.warn('turn-runner', 'possible.tool.loop', { callId: r.call.id, name: r.call.name, sig, sameCount, roundIdx: iter })
          }
        }

        yield { type: 'wave.completed', sessionId, turnId, waveIndex: wi, callsInWave: wave.length, ts: Date.now() }
      }
    }

    if (log) log.info('turn-runner', 'turn.end', { sessionId, turnId, totalToolCalls: sigs.length, totalUsage, finalTextLen: finalText.length, durationMs: Date.now() - startTime })
    yield { type: 'turn.completed', sessionId, turnId, usage: totalUsage, finalMessage: finalText }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield {
      type: 'turn.failed',
      sessionId, turnId,
      stage: 'llm_stream',
      err: { message },
    }
  }
}
