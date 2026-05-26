import { describe, it, expect } from 'bun:test'
import { runTurnUsecase } from '../../../src/application/usecases/run-turn'
import type { RunTurnUsecaseDeps, RunTurnInput, LoggerPort } from '../../../src/application/usecases/run-turn'
import type { ContractBus } from '../../../src/application/event-bus/contract-bus'
import type { SessionHistoryPort } from '../../../src/application/ports/session-history'
import type { ProviderChat, ChatResponseChunk } from '../../../src/application/ports/provider'
import type { Compactor } from '../../../src/application/usecases/compact-session'
import { BUDGET_COMPACT_RATIO, BUDGET_DEFAULT_TOKEN_LIMIT, BUDGET_WARN_RATIO, BUDGET_DANGER_RATIO } from '../../../src/application/constants/compact'

function stubProvider(chunks: ChatResponseChunk[]): ProviderChat {
  return {
    stream: async function* () { for (const c of chunks) yield c; yield { type: 'done' } as ChatResponseChunk },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

function stubHistory(msgs: Array<{ role: string; content: string }> = []): SessionHistoryPort {
  let store = [...msgs]
  return {
    get: () => store,
    appendBatch: async () => {},
    replace: async (_sid: string, newMsgs: Array<{ role: string; content: string }>) => { store = [...newMsgs] },
    drop: async () => false,
  } as unknown as SessionHistoryPort
}

function stubBus(): { bus: ContractBus; events: unknown[] } {
  const events: unknown[] = []
  return {
    events,
    bus: {
      emit: (_t, p) => { events.push(p); return Promise.resolve() },
      on: () => () => {},
      emitWithResults: (_t, p) => { events.push(p); return Promise.resolve({ ok: true, failures: [] }) },
    },
  }
}

function stubLogger(): LoggerPort {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function deps(overrides?: Partial<RunTurnUsecaseDeps>): RunTurnUsecaseDeps {
  return {
    provider: stubProvider([{ type: 'text', delta: 'Hello' } as ChatResponseChunk]),
    hooks: {
      dispatch: async (name: string, ..._args: unknown[]) => {
        if (name === 'transformPrompt') return { system: 'sys', messages: _args[0] ? (_args[0] as { messages: Array<{ content: string }> }).messages : [] }
        if (name === 'resolveTools') return []
        return undefined
      },
    },
    sessionStore: { save: async () => {}, load: async () => null, list: async () => [], delete: async () => false },
    history: stubHistory(),
    bus: stubBus().bus,
    logger: stubLogger(),
    basePrompt: 'You are helpful.',
    agentDir: '/tmp/test-agent',
    sessionAbort: { register: () => {}, unregister: () => {} },
    compactor: { summarize: async () => ({ summary: 'x', usage: { input: 0, output: 0 } }) },
    ...overrides,
  }
}

const input: RunTurnInput = { sessionId: 's1', turnId: 't1', userInput: 'hi', frontendId: 'fe' }

describe('runTurnUsecase budget guard (M2)', () => {
  it('completes normally without triggering compact when under threshold', async () => {
    let c = 0
    const compactor: Compactor = { summarize: async () => { c++; return { summary: 'x', usage: { input: 0, output: 0 } } } }
    const { bus } = stubBus()
    const r = await runTurnUsecase(input, deps({ compactor, bus }))
    expect(r.success).toBe(true)
    expect(c).toBe(0)
  })

  it('compaction disabled prevents reactive compact', async () => {
    let c = 0
    const compactor: Compactor = { summarize: async () => { c++; return { summary: 'x', usage: { input: 0, output: 0 } } } }
    const bigMsg = { role: 'user' as const, content: 'x'.repeat(4096) }
    const h = stubHistory([bigMsg])
    const { bus } = stubBus()
    const r = await runTurnUsecase(
      { ...input, tokenLimit: 500, compaction: 'disabled', kind: 'sub-agent' },
      deps({ compactor, history: h, bus }),
    )
    expect(r.success).toBe(true)
    expect(c).toBe(0)
  })

  it('budget constants are defined with correct values', () => {
    expect(BUDGET_COMPACT_RATIO).toBe(0.75)
    expect(BUDGET_WARN_RATIO).toBe(0.70)
    expect(BUDGET_DANGER_RATIO).toBe(0.90)
    expect(BUDGET_DEFAULT_TOKEN_LIMIT).toBe(180_000)
  })
})
