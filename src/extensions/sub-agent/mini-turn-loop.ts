import type { SubAgentDescriptor } from './types'
import type { ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import { WorkerRpcError } from '../../infrastructure/jobs/spawn-rpc/errors'

export type ToolCallHandler = (call: {
  name: string
  arguments: Record<string, unknown>
  callId: string
}) => Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }>

export type LlmFailureReason =
  | 'network' | 'rate_limit' | 'auth' | 'invalid_response' | 'unknown'

interface MiniLoopDeps {
  descriptor: SubAgentDescriptor
  userPrompt: string
  subSessionId: string
  subTurnId: string
  parentTurnId: string
  chatComplete: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  dispatchTool: ToolCallHandler
  toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  progress?: (p: { kind: 'sub-agent.inner-tool'; innerCallId: string; toolName: string; phase: 'start' | 'end'; ok?: boolean; durationMs?: number }) => void
}

interface MiniLoopResult {
  finalText: string
  usage: { input: number; output: number }
  toolCallCount: number
  rounds: number
  finishReason: string
}

const DEFAULT_MAX_ROUNDS = 10
const MAX_TOOL_FAILURES_PER_NAME = 3
const MAX_EMPTY_ROUNDS = 2

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function classifyLlmError(err: unknown): LlmFailureReason {
  if (err instanceof WorkerRpcError) {
    switch (err.code) {
      case 'RATE_LIMITED': return 'rate_limit'
      case 'TIMEOUT': return 'network'
      case 'PURPOSE_NOT_ALLOWED': return 'auth'
      case 'PROVIDER_ERROR':
      case 'TOOL_NOT_ALLOWED':
      case 'TOOL_EXEC_FAIL':
      case 'TOOL_TIMEOUT':
      case 'WORKER_FATAL':
      case 'PROTOCOL_VIOLATION':
      case 'WORKER_CRASHED':
      case 'UNKNOWN':
      default: return 'unknown'
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.limit|429/i.test(msg)) return 'rate_limit'
  if (/timeout|TIMEOUT/i.test(msg)) return 'network'
  return 'unknown'
}

function handleNoToolCallsResponse(
  resp: ChatCompleteResponse,
  finalText: string,
  totalUsage: { input: number; output: number },
  toolCallCount: number,
  round: number,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): MiniLoopResult {
  const text = resp.content
  switch (resp.finishReason) {
    case 'stop':
      return { finalText: text, usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'stop' }
    case 'length':
      return {
        finalText: `<sub-agent-error type="response_truncated" reason="length"><partial-result>${escapeXml(resp.content)}</partial-result></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'length',
      }
    case 'content_filter':
      return {
        finalText: `<sub-agent-error type="response_filtered" reason="content_filter"></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'content_filter',
      }
    case 'tool_calls':
      log('warn', 'provider returned finishReason=tool_calls but no toolCalls in response')
      return {
        finalText: '<sub-agent-error type="provider_inconsistent" reason="finishReason=tool_calls but no toolCalls"></sub-agent-error>',
        usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'inconsistent',
      }
    default:
      if (!finalText) {
        return {
          finalText: `<sub-agent-error type="empty_response"></sub-agent-error>`,
          usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'empty',
        }
      }
      return { finalText: text || finalText, usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: resp.finishReason }
  }
}

export async function runMiniTurnLoop(deps: MiniLoopDeps): Promise<MiniLoopResult> {
  const { descriptor: desc, chatComplete, dispatchTool, toolSchemas, log } = deps
  const maxRounds = desc.maxRounds ?? DEFAULT_MAX_ROUNDS
  const maxTotalTokens = desc.maxTotalTokens ?? Infinity

  const messages: Array<{ role: string; content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; tool_call_id?: string; name?: string }> = [
    { role: 'system', content: desc.systemPrompt },
    { role: 'user', content: deps.userPrompt },
  ]

  let totalUsage = { input: 0, output: 0 }
  let toolCallCount = 0
  let finalText = ''
  const toolFailureCounts = new Map<string, number>()
  let consecutiveEmptyRounds = 0

  for (let round = 0; round < maxRounds; round++) {
    if (totalUsage.input + totalUsage.output > maxTotalTokens) {
      log('warn', `budget exhausted: ${totalUsage.input + totalUsage.output} > ${maxTotalTokens}`)
      return {
        finalText:
          `<sub-agent-error type="budget_exhausted" totalTokens="${totalUsage.input + totalUsage.output}" maxTokens="${maxTotalTokens}">` +
          `<partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1,
        finishReason: 'budget',
      }
    }

    let resp: ChatCompleteResponse
    try {
      resp = await chatComplete({
        purpose: `subagent.run.${desc.type}`,
        messages,
        tools: toolSchemas,
        maxTokens: desc.maxTokensPerCall,
      })
    } catch (err) {
      const reason = classifyLlmError(err)
      log('error', `chatComplete failed (${reason}): ${String(err)}`)
      return {
        finalText: `<sub-agent-error type="llm_failed" reason="${reason}"></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1,
        finishReason: 'error',
      }
    }

    totalUsage.input += resp.usage.input
    totalUsage.output += resp.usage.output

    const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
      && (resp.finishReason === 'stop' || resp.finishReason === 'tool_calls')
    if (isEmpty) {
      consecutiveEmptyRounds++
      if (consecutiveEmptyRounds >= MAX_EMPTY_ROUNDS) {
        log('warn', `terminating after ${consecutiveEmptyRounds} consecutive empty rounds`)
        return {
          finalText: `<sub-agent-warning type="empty_rounds" rounds="${consecutiveEmptyRounds}"></sub-agent-warning>`,
          usage: totalUsage, toolCallCount, rounds: round + 1,
          finishReason: 'empty_rounds',
        }
      }
      messages.push({ role: 'user', content: 'You produced no output. Either call a tool or output your final answer.' })
      continue
    }
    consecutiveEmptyRounds = 0

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return handleNoToolCallsResponse(resp, finalText, totalUsage, toolCallCount, round, log)
    }

    messages.push({ role: 'assistant', content: resp.content, tool_calls: resp.toolCalls })

    for (const tc of resp.toolCalls) {
      toolCallCount++
      const innerCallId = `${deps.subTurnId}:${tc.id}`
      const toolStartTs = Date.now()

      deps.progress?.({ kind: 'sub-agent.inner-tool', innerCallId, toolName: tc.name, phase: 'start' })

      const response = await dispatchTool({ name: tc.name, arguments: tc.arguments, callId: tc.id })

      deps.progress?.({ kind: 'sub-agent.inner-tool', innerCallId, toolName: tc.name, phase: 'end', ok: response.success, durationMs: Date.now() - toolStartTs })

      if (!response.success) {
        const code = response.error?.code
        if (code === 'TOOL_NOT_ALLOWED' || code === 'TOOL_NOT_FOUND') {
          return {
            finalText: `<sub-agent-error type="tool_unavailable" toolName="${tc.name}" reason="${code}"></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1,
            finishReason: 'tool_unavailable',
          }
        }
        const count = (toolFailureCounts.get(tc.name) ?? 0) + 1
        toolFailureCounts.set(tc.name, count)
        messages.push({
          role: 'tool',
          content: `<tool-error>${escapeXml(response.error!.message)}</tool-error>`,
          tool_call_id: tc.id,
          name: tc.name,
        })
        if (count >= MAX_TOOL_FAILURES_PER_NAME) {
          return {
            finalText: `<sub-agent-error type="tool_failed" toolName="${tc.name}" attempts="${count}"><partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1,
            finishReason: 'tool_failed',
          }
        }
      } else {
        messages.push({
          role: 'tool',
          content: typeof response.result === 'string' ? response.result : JSON.stringify(response.result),
          tool_call_id: tc.id,
          name: tc.name,
        })
      }
    }
  }

  log('warn', `maxRounds=${maxRounds} reached, force-finalizing`)
  return {
    finalText:
      `<sub-agent-error type="max_rounds_reached" rounds="${maxRounds}" maxRounds="${maxRounds}">` +
      `<partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
    usage: totalUsage, toolCallCount, rounds: maxRounds,
    finishReason: 'max_rounds',
  }
}
