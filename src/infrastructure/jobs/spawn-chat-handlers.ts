import type { JobContext } from '../../application/ports/job-spawner'
import type { Logger } from '../../application/ports/logger'
import type { ProviderChat } from '../../application/ports/provider'
import { encodeFrame, type Frame } from './spawn-rpc/frame'

export const CHAT_PURPOSE_PREFIXES = ['subagent.run.']

// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const MAX_MESSAGE_SIZE = 128 * 1024 // 128KB

export async function handleChatRequest(
  frame: Frame,
  stdin: { write: (d: Uint8Array | string) => number | Promise<number> },
  jobType: string,
  _spawnId: string,
  chatComplete: ProviderChat['complete'],
  logger: Logger,
): Promise<void> {
  const payload = frame.payload as {
    purpose?: string
    messages?: Array<{ role: string; content: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    maxTokens?: number
  }
  const purpose = payload.purpose ?? ''

  if (!CHAT_PURPOSE_PREFIXES.some(p => purpose.startsWith(p))) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PURPOSE_NOT_ALLOWED', message: `purpose "${purpose}" not allowed for chat-req` },
    }))
    return
  }

  const raw = JSON.stringify(payload.messages ?? [])
  if (raw.length > MAX_MESSAGE_SIZE) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: `messages exceed ${MAX_MESSAGE_SIZE} byte limit` },
    }))
    return
  }

  const startTime = Date.now()
  try {
    const resp = await chatComplete({
      purpose: payload.purpose ?? '',
      messages: payload.messages ?? [],
      tools: payload.tools ?? [],
      maxTokens: payload.maxTokens,
    })
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-resp', ts: Date.now(),
      payload: {
        content: resp.content,
        toolCalls: resp.toolCalls,
        finishReason: resp.finishReason,
        usage: resp.usage,
      },
    }))
    const latencyMs = Date.now() - startTime
    logger.info('spawn', `chat ok [${jobType}] purpose=${purpose} latency=${latencyMs}ms`, { jobType, purpose, latencyMs })
  } catch (err) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: err instanceof Error ? err.message : String(err) },
    }))
  }
}

export async function handleToolCall(
  frame: Frame,
  stdin: { write: (d: Uint8Array | string) => number | Promise<number> },
  ctx: JobContext,
  _jobType: string,
  _spawnId: string,
): Promise<void> {
  const payload = frame.payload as { name?: string; arguments?: Record<string, unknown>; callId?: string }
  if (!ctx.dispatchTool) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: { success: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'tool dispatch not enabled for this worker' } },
    }))
    return
  }
  try {
    const result = await ctx.dispatchTool({
      name: payload.name ?? '',
      arguments: payload.arguments ?? {},
      callId: payload.callId ?? '',
    })
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: result,
    }))
  } catch (err) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: { success: false, error: { code: 'TOOL_EXEC_FAIL', message: err instanceof Error ? err.message : String(err) } },
    }))
  }
}

export function relayProgress(frame: Frame, pid: number, jobType: string, logger: Logger): void {
  const payload = frame.payload as { kind?: string; data?: Record<string, unknown> }
  logger.info('spawn', `[worker ${jobType} pid=${pid}] progress: ${payload.kind ?? 'unknown'}`, { jobType, pid, ...payload.data })
}
