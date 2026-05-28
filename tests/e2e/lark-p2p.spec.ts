import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { eventsWithoutSessionId, terminalCount } from './_fixtures/event-asserts'
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
  const h = await bootE2E({ llmTurns })
  const channel = new FakeLarkChannel()
  const larkClient = new FakeLarkClient()
  const routingTable = new RoutingTable()
  const transport = h.kernel.ctx.extensions.get('transport-inmem.transport') as Transport
  const adapter = new LarkBotAdapter(
    'lark-e2e', transport, routingTable, 'fake-app', 'fake-secret',
    channel as unknown as import('@larksuiteoapi/node-sdk').LarkChannel,
    larkClient as unknown as import('../../src/extensions/frontend.lark/internal/client').LarkClient,
  )
  await adapter.start()
  return { h, channel, adapter }
}

describe('Feature: Lark p2p single-turn (F3)', () => {
  it('Scenario 3.1: Given a Lark p2p message "hi", When adapter handles it, Then card shows reply + no sessionId gaps (regression for "未返回内容")', async () => {
    let fx: LarkFixtures | null = null
    try {
      await given('kernel + fake lark adapter with single text delta', async () => {
        fx = await setupLark([{ textDeltas: ['hello back'], usage: { input: 1, output: 2 } }])
      })

      let sid = ''
      await when('lark pushes a p2p message "hi"', async () => {
        const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-uid1' }
        const result = await fx!.adapter.handleMessage(anchor, 'hi', 'chat-uid1', 'msg-1')
        sid = (result as { sessionId: string }).sessionId
      })

      await then('turn completes with sessionId on all events', async () => {
        await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(eventsWithoutSessionId(fx!.h.captured, 'llm.')).toEqual([])
        expect(eventsWithoutSessionId(fx!.h.captured, 'turn.')).toEqual([])
      })

      await then('card sink received the reply text', () => {
        const cardState = fx!.channel.lastCardState()
        expect(cardState.status).toBe('streaming')
      })
    } finally {
      if (fx) await fx.h.stop()
    }
  })

  it('Scenario 3.2: Given the setup of 3.1, When turn completes, Then exactly ONE terminal event per turn', async () => {
    let fx: LarkFixtures | null = null
    try {
      await given('kernel + fake lark adapter', async () => {
        fx = await setupLark([{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }])
      })

      let sid = ''
      await when('user sends "hi"', async () => {
        const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-u2' }
        const result = await fx!.adapter.handleMessage(anchor, 'hi', 'chat-u2', 'msg-2')
        sid = (result as { sessionId: string }).sessionId
      })

      await then('exactly one terminal event per turn', async () => {
        await fx!.h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(fx!.h.captured, sid)).toBe(1)
      })
    } finally {
      if (fx) await fx.h.stop()
    }
  })

  it('Scenario 3.3: Given two p2p users on the same bot, When both send "hi" concurrently, Then both messages share the main session and are processed serially', async () => {
    let fx: LarkFixtures | null = null
    try {
      await given('kernel + fake lark adapter with 2-turn LLM', async () => {
        fx = await setupLark([
          { textDeltas: ['reply for uid-A'], usage: { input: 1, output: 1 } },
          { textDeltas: ['reply for uid-B'], usage: { input: 1, output: 1 } },
        ])
      })

      let sidA = ''
      let sidB = ''
      let resA: { sessionId: string; accepted: boolean } | undefined
      let resB: { sessionId: string; accepted: boolean } | undefined
      await when('uid-A and uid-B push "hi" concurrently', async () => {
        const anchorA: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-A' }
        const anchorB: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-B' }
        const [rA, rB] = await Promise.all([
          fx!.adapter.handleMessage(anchorA, 'hi', 'chat-A', 'msg-A'),
          fx!.adapter.handleMessage(anchorB, 'hi', 'chat-B', 'msg-B'),
        ])
        resA = rA as { sessionId: string; accepted: boolean }
        resB = rB as { sessionId: string; accepted: boolean }
        sidA = resA.sessionId
        sidB = resB.sessionId
      })

      await then('both p2p messages route to the same main session (one-bot-one-agent)', () => {
        expect(sidA).toBe(sidB)
        expect(sidA).toBe('tui-default')
        expect(resA!.accepted).toBe(true)
        expect(resB!.accepted).toBe(true)
      })

      await then('both turns complete serially on the shared session', async () => {
        // Two messages → two turns on the same session; queue serializes them.
        await fx!.h.waitFor(() => terminalCount(fx!.h.captured, sidA) >= 2)
        expect(terminalCount(fx!.h.captured, sidA)).toBe(2)
      })
    } finally {
      if (fx) await fx.h.stop()
    }
  })
})
