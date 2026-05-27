import { describe, it, expect } from 'bun:test'
import { bootE2E } from '../_fixtures/boot-kernel'

describe('PR-1 Smoke: E2E infra boots', () => {
  it('bootE2E assembles a real kernel with presets + starts', async () => {
    const h = await bootE2E()
    try {
      expect(h.kernel.ctx.extensions.list()).toContain('dataplane')
      expect(h.kernel.ctx.extensions.list()).toContain('session')
      expect(h.kernel.ctx.extensions.list().length).toBeGreaterThanOrEqual(9)
    } finally {
      await h.stop()
    }
  })

  it('inmem transport is reachable + client can call RPC', async () => {
    const h = await bootE2E()
    try {
      const tools = await h.client.getToolList()
      expect(Array.isArray(tools)).toBe(true)
    } finally {
      await h.stop()
    }
  })

  it('capture records bus events with sessionId on turn events', async () => {
    const h = await bootE2E({
      llmTurns: [{ textDeltas: ['hello from e2e'], usage: { input: 1, output: 1 } }],
    })
    try {
      const { sessionId } = await h.client.createSession('smoke')
      await h.client.sendInput(sessionId, 'hi')
      await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)
      const deltas = h.captured.filter(e => e.type === 'llm.delta' && e.sessionId === sessionId)
      expect(deltas.length).toBeGreaterThan(0)
      expect(h.captured.filter(e => e.type === 'llm.delta' && !e.sessionId)).toEqual([])
    } finally {
      await h.stop()
    }
  })
})
