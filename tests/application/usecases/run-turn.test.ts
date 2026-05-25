import { describe, it, expect } from 'bun:test'
import { runTurnUsecase } from '../../../src/application/usecases/run-turn'
import type {
  RunTurnUsecaseDeps, RunTurnInput, BusPort, LoggerPort,
} from '../../../src/application/usecases/run-turn'
import type { SessionHistoryPort } from '../../../src/application/ports/session-history'
import type { ProviderChat, ChatResponseChunk } from '../../../src/application/ports/provider'
import type { SessionStore } from '../../../src/application/ports/session-store'

// ── Stubs ──────────────────────────────────────────────────────────────────

function stubProvider(chunks: ChatResponseChunk[]): ProviderChat {
  return {
    stream: async function* () { for (const c of chunks) yield c },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

function stubHooks(overrides?: {
  transformPrompt?: unknown
  resolveTools?: unknown
  onToolCall?: unknown
  onTurnEnd?: unknown
}) {
  const turnEndCalls: Array<{ status: string; error?: { stage: string; reason: string } }> = []
  return {
    turnEndCalls,
    dispatch: async (name: string, ..._args: unknown[]) => {
      if (name === 'transformPrompt') {
        if (overrides?.transformPrompt === 'throw') throw new Error('transformPrompt down')
        return overrides?.transformPrompt ?? { system: 'sys', messages: [{ role: 'user', content: _args[0] ? (_args[0] as { messages: Array<{ content: string }> }).messages[0].content : '' }] }
      }
      if (name === 'resolveTools') {
        if (overrides?.resolveTools === 'throw') throw new Error('resolveTools down')
        return overrides?.resolveTools ?? []
      }
      if (name === 'onToolCall') {
        if (overrides?.onToolCall === 'throw') throw new Error('tool down')
        return overrides?.onToolCall ?? 'tool-result'
      }
      if (name === 'onTurnEnd') {
        if (overrides?.onTurnEnd === 'throw') throw new Error('onTurnEnd down')
        const arg = _args[0] as { status: string; error?: { stage: string; reason: string } }
        turnEndCalls.push({ status: arg.status, error: arg.error })
        return undefined
      }
      return undefined
    },
  }
}

function stubHistory(msgs: Array<{ role: string; content: string }> = []): SessionHistoryPort {
  const store = [...msgs]
  return {
    get: () => store,
    appendBatch: async (_sid: string, newMsgs: Array<{ role: string; content: string }>) => { store.push(...newMsgs) },
    replace: async (_sid: string, newMsgs: Array<{ role: string; content: string }>) => { store.length = 0; store.push(...newMsgs) },
    drop: async () => false,
  } as unknown as SessionHistoryPort
}

function stubBus(): { bus: BusPort; events: unknown[] } {
  const events: unknown[] = []
  return {
    events,
    bus: { emit: (_type, payload) => { events.push(payload) } },
  }
}

function stubLogger(): LoggerPort {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function stubSessionStore(): SessionStore {
  return {
    save: async () => {},
    load: async () => null,
    list: async () => [],
    delete: async () => false,
  }
}

function deps(overrides?: Partial<RunTurnUsecaseDeps>): RunTurnUsecaseDeps {
  return {
    provider: stubProvider([{ type: 'text', delta: 'Hello' }, { type: 'done' }]),
    hooks: stubHooks(),
    sessionStore: stubSessionStore(),
    history: stubHistory(),
    bus: stubBus().bus,
    logger: stubLogger(),
    basePrompt: 'You are helpful.',
    agentDir: '/tmp/test-agent',
    sessionAbort: {
      register: () => {},
      unregister: () => {},
    },
    ...overrides,
  }
}

const input: RunTurnInput = { sessionId: 's1', turnId: 't1', userInput: 'hi', frontendId: 'fe' }

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runTurnUsecase', () => {
  it('completes a simple text turn', async () => {
    const hooks = stubHooks()
    const { bus } = stubBus()
    const result = await runTurnUsecase(input, deps({ bus, hooks }))

    expect(result.success).toBe(true)
    expect(hooks.turnEndCalls.length).toBeGreaterThanOrEqual(1)
    expect(hooks.turnEndCalls[hooks.turnEndCalls.length - 1].status).toBe('completed')
  })

  it('emits turn.failed when transformPrompt throws', async () => {
    const hooks = stubHooks({ transformPrompt: 'throw' })
    const { bus } = stubBus()
    const d = deps({ bus, hooks })
    const result = await runTurnUsecase(input, d)

    expect(result.success).toBe(false)
    const failed = hooks.turnEndCalls.find((c) => c.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.error?.stage).toBe('transformPrompt')
    expect(failed!.error?.reason).toBe('transformPrompt down')
  })

  it('emits turn.failed when resolveTools throws', async () => {
    const hooks = stubHooks({ resolveTools: 'throw' })
    const { bus } = stubBus()
    const d = deps({ bus, hooks })
    const result = await runTurnUsecase(input, d)

    expect(result.success).toBe(false)
    const failed = hooks.turnEndCalls.find((c) => c.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.error?.stage).toBe('resolveTools')
  })

  it('handles tool call round-trip', async () => {
    const { events, bus } = stubBus()
    let round = 0
    const provider: ProviderChat = {
      stream: async function* () {
        round++
        if (round === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 't1', name: 'read', arguments: '{"path":"/f"}' } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', delta: 'OK' }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const result = await runTurnUsecase(input, deps({ provider, bus }))
    expect(result.success).toBe(true)
    expect(events.some((e: unknown) => (e as { type: string }).type === 'tool.start')).toBe(true)
    expect(events.some((e: unknown) => (e as { type: string }).type === 'tool.end')).toBe(true)
  })

  it('calls history.appendBatch after successful turn', async () => {
    let appendedMsgs: unknown[] = []
    const history = {
      get: () => [] as Array<{ role: string; content: string }>,
      appendBatch: async (_sid: string, msgs: Array<{ role: string }>) => { appendedMsgs = msgs },
      replace: async () => {},
    }
    const { bus } = stubBus()

    const result = await runTurnUsecase(input, deps({ history, bus }))
    expect(result.success).toBe(true)
    expect(appendedMsgs.length).toBeGreaterThan(0)
    expect(appendedMsgs[0]).toMatchObject({ role: 'user' })
  })
})
