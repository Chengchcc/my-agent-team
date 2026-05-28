import { createTraceEventFactory } from '../../domain/trace-event'
import { truncateForTrace } from '../../infrastructure/trace/trace-sanitizer'
import { approxTokens } from '../constants/compact'

export function emitTraceRequest(
  hooks: { dispatch(name: string, ...args: unknown[]): Promise<unknown> },
  sessionId: string,
  turnId: string,
  system: string,
  basePrompt: string,
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  toolNames: string[],
): ReturnType<typeof createTraceEventFactory> {
  const traceFactory = createTraceEventFactory(sessionId)
  const llmRequestPayload: Record<string, unknown> = {
    system: truncateForTrace(system),
    messages: messages.map(m => ({ role: m.role, contentLength: (m.content?.length ?? 0) })),
    toolNames,
    systemBytes: Buffer.byteLength(system, 'utf-8'),
    messagesBytes: Buffer.byteLength(JSON.stringify(messages), 'utf-8'),
    totalTokensEstimate: approxTokens(system + JSON.stringify(messages)),
  }
  if (process.env.MY_AGENT_TRACE_FULL) {
    llmRequestPayload.messagesFull = messages.map(m => ({
      role: m.role,
      content: truncateForTrace(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
    }))
  }
  void hooks.dispatch('onTraceEmit', traceFactory.next(turnId, 'llm.request', llmRequestPayload))

  if (process.env.MY_AGENT_TRACE_VERBOSE) {
    void hooks.dispatch('onTraceEmit', createTraceEventFactory(sessionId).next(turnId, 'prompt.snapshot', {
      hookName: 'transformPrompt.pipeline',
      enforce: 'all', order: 0,
      systemBefore: truncateForTrace(basePrompt),
      systemAfter: truncateForTrace(system),
      deltaBytes: Buffer.byteLength(system) - Buffer.byteLength(basePrompt),
    }))
  }

  return traceFactory
}
