import type {
  ProviderChat,
  ProviderInvoke,
  ChatRequest,
  ChatResponseChunk,
  ChatResponse,
  InvokeRequest,
  InvokeResponse,
} from '../../application/ports/provider'

/**
 * EchoProvider — test/mock provider that echoes back the last message.
 * Implements both ProviderChat and ProviderInvoke.
 * Does NOT use an adapter layer (no wire format exists for echo).
 */
const ECHO_PREFIX_LENGTH = 6

export class EchoProvider implements ProviderChat, ProviderInvoke {
  readonly providerId = 'echo' as const
  readonly model = 'echo'

  async *stream(req: ChatRequest): AsyncGenerator<ChatResponseChunk> {
    const lastMsg = req.messages[req.messages.length - 1]?.content ?? ''
    yield { type: 'text', delta: `ECHO: ${lastMsg}` }
    yield {
      type: 'usage',
      usage: { input: lastMsg.length, output: lastMsg.length + ECHO_PREFIX_LENGTH },
    }
    yield { type: 'done', finishReason: 'stop' }
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const lastMsg = req.messages[req.messages.length - 1]?.content ?? ''
    return {
      id: 'echo-' + Date.now(),
      content: `ECHO: ${lastMsg}`,
      finishReason: 'stop',
      usage: { input: lastMsg.length, output: lastMsg.length + ECHO_PREFIX_LENGTH },
      model: 'echo',
    }
  }

  async call(req: InvokeRequest): Promise<InvokeResponse> {
    const lastMsg = req.messages[req.messages.length - 1]?.content ?? ''
    return {
      content: `ECHO(internal,${req.purpose}): ${lastMsg}`,
      usage: { input: 0, output: 0 },
    }
  }
}
