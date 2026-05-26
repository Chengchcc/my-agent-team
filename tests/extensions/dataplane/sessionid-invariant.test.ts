import { describe, it, expect, afterEach } from 'bun:test'
import { bootMinimalKernel, type MinimalKernel } from '../../helpers/boot-minimal-kernel'

const PER_SESSION_DP_TYPES = new Set([
  'assistant.delta', 'tool.update', 'turn.started', 'turn.completed', 'turn.failed',
])

describe('DataPlane sessionId invariant', () => {
  let mk: MinimalKernel | null = null
  afterEach(async () => { if (mk) await mk.kernel.stop(); mk = null })

  it('(a) every per-session DataPlaneEvent has a non-empty sessionId', async () => {
    mk = await bootMinimalKernel({
      presetChunks: {
        textDeltas: ['Hello', ', ', 'world'],
        usage: { input: 0, output: 3 },
      },
    })
    await mk.runTurn('S', 'T', 'hi')

    const offenders = mk.capturedDpEvents
      .filter(e => PER_SESSION_DP_TYPES.has(e.type))
      .filter(e => !e.sessionId)

    expect(offenders, `events without sessionId: ${offenders.map(o => `${o.type}/${o.evId}`).join(', ')}`)
      .toEqual([])
  })

  it('(b) emits exactly ONE turn.completed per turn (no shadow duplicate)', async () => {
    mk = await bootMinimalKernel({
      presetChunks: {
        textDeltas: ['ok'],
        usage: { input: 0, output: 1 },
      },
    })
    await mk.runTurn('S', 'T', 'hi')

    const terminals = mk.capturedDpEvents.filter(e => e.type === 'turn.completed' || e.type === 'turn.failed')
    expect(terminals.length, `expected 1 terminal, got ${terminals.length}: ${terminals.map(t => t.type).join(',')}`)
      .toBe(1)
  })
})
