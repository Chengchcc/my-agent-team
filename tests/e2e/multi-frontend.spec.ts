import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'
import { FakeLarkChannel } from './_fixtures/fake-lark-channel'
import { FakeLarkClient } from './_fixtures/fake-lark-client'
import { LarkBotAdapter } from '../../src/extensions/frontend.lark/lark-bot-adapter'
import { RoutingTable } from '../../src/extensions/frontend.lark/routing-table'
import type { Transport } from '../../src/application/ports/transport'
import type { Anchor } from '../../src/domain/anchor'

interface LarkFixtures {
  h: E2EHandle
  channel: FakeLarkChannel
  adapter: LarkBotAdapter
}

async function setupLark(
  llmTurns: Array<{ textDeltas?: string[]; usage?: { input: number; output: number } }>,
): Promise<LarkFixtures> {
  const h = await bootE2E({ llmTurns, withLark: true })
  const channel = new FakeLarkChannel()
  const larkClient = new FakeLarkClient()
  const routingTable = new RoutingTable()
  const transport = h.kernel.ctx.extensions.get('transport-inmem.transport') as Transport
  const adapter = new LarkBotAdapter(
    'lark-e2e-f14', transport, routingTable, 'fake-app', 'fake-secret',
    channel as unknown as import('@larksuiteoapi/node-sdk').LarkChannel,
    larkClient as unknown as import('../../src/extensions/frontend.lark/internal/client').LarkClient,
  )
  await adapter.start()
  return { h, channel, adapter }
}

describe('Feature: Multi-Frontend Route Isolation (F14)', () => {
  it('Scenario 14.1: Lark messages do not interfere with TUI frontend', async () => {
    let fx: LarkFixtures | null = null
    try {
      await given('kernel with Lark adapter + 2-turn LLM', async () => {
        fx = await setupLark([
          { textDeltas: ['lark reply'], usage: { input: 1, output: 1 } },
          { textDeltas: ['tui reply'], usage: { input: 1, output: 1 } },
        ])
      })

      let larkSid = ''
      let tuiSid = ''

      await when('Lark user and TUI user send messages', async () => {
        // Lark user sends via adapter
        const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-A' }
        const larkResult = await fx!.adapter.handleMessage(anchor, 'lark msg', 'chat-A', 'msg-A')
        larkSid = (larkResult as { sessionId: string }).sessionId

        // TUI user sends via session client
        const { sessionId } = await fx!.h.client.createSession()
        tuiSid = sessionId
        await fx!.h.client.sendInput(tuiSid, 'tui msg')
      })

      await then('both turns complete independently', async () => {
        await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === larkSid)
        await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === tuiSid)
        expect(terminalCount(fx!.h.captured, larkSid)).toBe(1)
        expect(terminalCount(fx!.h.captured, tuiSid)).toBe(1)
        // Lark and TUI use different sessions
        expect(larkSid).not.toBe(tuiSid)
      })
    } finally {
      if (fx) await fx.h.stop()
    }
  })

  it('Scenario 14.3: frontend detach does not affect other frontends', async () => {
    let fx: LarkFixtures | null = null
    try {
      await given('kernel with Lark adapter + multi-turn LLM', async () => {
        fx = await setupLark([
          { textDeltas: ['first'], usage: { input: 1, output: 1 } },
          { textDeltas: ['second'], usage: { input: 1, output: 1 } },
        ])
      })

      const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-B' }
      const larkResult = await fx!.adapter.handleMessage(anchor, 'hi', 'chat-B', 'msg-B')
      const larkSid = (larkResult as { sessionId: string }).sessionId

      await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === larkSid)
      expect(terminalCount(fx!.h.captured, larkSid)).toBe(1)

      // Stop adapter (simulates detach)
      await fx!.adapter.stop()

      // Send another message via TUI client — should still work
      const { sessionId } = await fx!.h.client.createSession()
      const tuiSid = sessionId
      await fx!.h.client.sendInput(tuiSid, 'after detach')
      await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === tuiSid)

      await then('TUI turn completes after Lark detach', () => {
        expect(terminalCount(fx!.h.captured, tuiSid)).toBe(1)
      })
    } finally {
      if (fx) await fx.h.stop()
    }
  })
})
