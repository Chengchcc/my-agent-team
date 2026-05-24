import type {
  TurnEvent, RunTurnDeps, RoundResult,
  ToolCall, LlmMessage, ChatResponseChunk,
} from './turn-runner.types'
import { partitionWaves } from './wave-scheduler'
import type { ToolConflictMeta } from './wave-scheduler'

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

export async function* runTurn(deps: RunTurnDeps): AsyncGenerator<TurnEvent, void, void> {
  const { sessionId, turnId, messages, tools, provider, hooks } = deps
  const max = deps.maxIterations ?? 10

  let currentMessages: LlmMessage[] = [...messages]
  let finalText = ''
  let totalUsage = { input: 0, output: 0 }

  try {
    for (let iter = 0; iter < max; iter++) {
      if (deps.abortSignal?.aborted) break
      const round = yield* consumeRound(
        provider.stream({ messages: currentMessages, tools, signal: deps.abortSignal }),
        { sessionId, turnId },
      )

      totalUsage.input += round.usage.input
      totalUsage.output += round.usage.output

      if (round.assistantText) {
        finalText += round.assistantText
        currentMessages.push({ role: 'assistant', content: round.assistantText })
      }

      if (round.toolCalls.length === 0) break

      if (deps.abortSignal?.aborted) break

      // Build descriptor map for wave scheduling
      const descMap = new Map<string, ToolConflictMeta>()
      for (const t of deps.tools) {
        if (t.readonly !== undefined || t.conflictKey) {
          descMap.set(t.name, { readonly: t.readonly, conflictKey: t.conflictKey })
        }
      }

      const waves = deps.parallelTools
        ? partitionWaves(round.toolCalls, descMap)
        : round.toolCalls.map(c => [c])

      for (const wave of waves) {
        if (deps.abortSignal?.aborted) break

        // Yield all tool.start in submission order at wave entry
        for (const call of wave) {
          yield {
            type: 'tool.start',
            sessionId, turnId,
            callId: call.id, name: call.name, args: call.arguments,
          }
        }

        // Execute wave calls concurrently via Promise.allSettled
        const settled = await Promise.allSettled(wave.map(call =>
          hooks.onToolCall(call).then(
            result => ({ call, ok: true as const, result }),
            (err: unknown) => ({ call, ok: false as const, err: err instanceof Error ? err.message : String(err) }),
          ),
        ))

        // Yield results in submission order (LLM call order)
        for (const s of settled) {
          if (s.status === 'rejected') {
            const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
            yield { type: 'turn.failed', sessionId, turnId, stage: 'llm_stream' as const, err: { message: msg } }
            return
          }
          const r = s.value
          if (r.ok) {
            yield { type: 'tool.end', sessionId, turnId, callId: r.call.id, name: r.call.name, result: r.result }
            currentMessages.push({ role: 'user', content: `Tool ${r.call.name} result: ${JSON.stringify(r.result)}` })
          } else {
            yield { type: 'tool.error', sessionId, turnId, callId: r.call.id, name: r.call.name, err: { message: r.err } }
            currentMessages.push({ role: 'user', content: `Tool ${r.call.name} error: ${r.err}` })
          }
        }
      }
    }

    yield {
      type: 'turn.completed',
      sessionId, turnId,
      usage: totalUsage, finalMessage: finalText,
    }
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
