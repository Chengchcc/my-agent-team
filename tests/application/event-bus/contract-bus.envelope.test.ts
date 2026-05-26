import { describe, it, expect } from 'bun:test'
import { asContractBus } from '../../../src/application/event-bus/contract-bus'

describe('ContractBus envelope routing', () => {
  it('propagates sessionId & turnId via opts to envelope', async () => {
    const seen: Array<{ type: string; payload: unknown }> = []
    const raw = {
      emit: async (t: string, e: unknown) => { seen.push({ type: t, payload: e }) },
      on: () => () => {},
    }
    const cb = asContractBus(raw)
    await cb.emit('turn.completed',
      { sessionId: 'S', turnId: 'T', usage: { input: null, output: null }, toolCallCount: 0, toolErrorCount: 0, activatedSkills: [] },
      { sessionId: 'S', turnId: 'T' },
    )
    const env = seen[0]!.payload as { sessionId?: string; turnId?: string; payload?: { sessionId?: string } }
    expect(env.sessionId).toBe('S')
    expect(env.turnId).toBe('T')
    expect(env.payload?.sessionId).toBe('S')
  })

  it('DOCUMENTS THE TRAP: envelope.sessionId is undefined when opts omitted', async () => {
    const seen: Array<{ payload: unknown }> = []
    const raw = { emit: async (_t: string, e: unknown) => { seen.push({ payload: e }) }, on: () => () => {} }
    const cb = asContractBus(raw)
    await cb.emit('llm.delta', { sessionId: 'S', turnId: 'T', delta: 'x' })   // BAD style — no opts
    const env = seen[0]!.payload as { sessionId?: string }
    expect(env.sessionId).toBeUndefined()   // documents the gap Edit ③ closes
  })
})
