import type { ProviderChat, ChatRequest, ChatResponse, ChatResponseChunk } from '../../../src/application/ports/provider'

export type E2ETurn = {
  textDeltas?: string[]
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  usage?: { input: number; output: number }
  errorAfter?: number
  /** Inter-chunk delay in ms — enables abort mid-stream testing. */
  delayMs?: number
}

/**
 * ProviderChat-compatible fake for E2E tests.
 * Separate from tests/fixtures/fake-provider.ts to avoid affecting 96 existing unit tests.
 * Yields real ChatResponseChunk union types consumed by turn-runner.
 */
export class E2EFakeProvider implements ProviderChat {
  private turns: E2ETurn[] = []
  private cursor = 0
  readonly receivedRequests: ChatRequest[] = []
  abortObserved = false

  setTurns(t: E2ETurn[]) { this.turns = t; this.cursor = 0 }

  async *stream(req: ChatRequest): AsyncGenerator<ChatResponseChunk> {
    this.receivedRequests.push(req)
    req.signal?.addEventListener('abort', () => { this.abortObserved = true })
    const turn = this.turns[this.cursor++] ?? { textDeltas: ['(no preset)'] }
    let n = 0

    for (const delta of turn.textDeltas ?? []) {
      if (turn.errorAfter !== undefined && n >= turn.errorAfter) throw new Error('E2EFakeProvider: simulated error')
      if (req.signal?.aborted) { this.abortObserved = true; return }
      if (turn.delayMs) await new Promise(r => setTimeout(r, turn.delayMs))
      yield { type: 'text', delta }
      n++
    }
    for (const tc of turn.toolCalls ?? []) {
      if (turn.errorAfter !== undefined && n >= turn.errorAfter) throw new Error('E2EFakeProvider: simulated error')
      if (req.signal?.aborted) { this.abortObserved = true; return }
      yield { type: 'tool_call_start', toolCall: tc }
      n++
    }
    yield { type: 'usage', usage: turn.usage ?? { input: 0, output: 0 } }
    yield { type: 'done' }
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.receivedRequests.push(req)
    const turn = this.turns[this.cursor++] ?? { textDeltas: ['(no preset)'] }
    return {
      id: `e2e-${Date.now()}`,
      content: (turn.textDeltas ?? []).join(''),
      toolCalls: turn.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments) })),
      usage: turn.usage ?? { input: 0, output: 0 },
      model: 'e2e-fake',
    }
  }
}
