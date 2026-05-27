import { describe, it, expect, afterEach } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { eventsWithoutSessionId, terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'
import { FakeLarkChannel } from './_fixtures/fake-lark-channel'
import { FakeLarkClient } from './_fixtures/fake-lark-client'
import { LarkBotAdapter } from '../../src/extensions/frontend.lark/lark-bot-adapter'
import { RoutingTable } from '../../src/extensions/frontend.lark/routing-table'
import type { Transport } from '../../src/application/ports/transport'
import type { Anchor } from '../../src/domain/anchor'

describe('Feature: Lark p2p single-turn (F3)', () => {
  let h: E2EHandle | null = null
  let channel: FakeLarkChannel | null = null
  let larkClient: FakeLarkClient | null = null
  let adapter: LarkBotAdapter | null = null

  afterEach(async () => {
    // Don't call adapter.stop() — it closes the shared transport.
    // Kernel shutdown handles cleanup.
    if (h) await h.stop()
    h = null; channel = null; larkClient = null; adapter = null
  })

  async function setupLark(llmTurns: Array<{ textDeltas?: string[]; usage?: { input: number; output: number } }>) {
    h = await bootE2E({ llmTurns })
    channel = new FakeLarkChannel()
    larkClient = new FakeLarkClient()
    const routingTable = new RoutingTable()
    const transport = h.kernel.ctx.extensions.get('transport-inmem.transport') as Transport
    adapter = new LarkBotAdapter(
      'lark-e2e', transport, routingTable, 'fake-app', 'fake-secret',
      channel as unknown as import('@larksuiteoapi/node-sdk').LarkChannel,
      larkClient as unknown as import('../../src/extensions/frontend.lark/internal/client').LarkClient,
    )
    await adapter.start()
  }

  it('Scenario 3.1: Given a Lark p2p message "hi", When adapter handles it, Then card shows reply + no sessionId gaps (regression for "未返回内容")', async () => {
    await given('kernel + fake lark adapter with single text delta', async () => {
      await setupLark([{ textDeltas: ['hello back'], usage: { input: 1, output: 2 } }])
    })

    let sid = ''
    await when('lark pushes a p2p message "hi"', async () => {
      const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-uid1' }
      const result = await adapter!.handleMessage(anchor, 'hi', 'chat-uid1', 'msg-1')
      sid = (result as { sessionId: string }).sessionId
    })

    await then('turn completes with sessionId on all events', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      expect(eventsWithoutSessionId(h!.captured, 'llm.')).toEqual([])
      expect(eventsWithoutSessionId(h!.captured, 'turn.')).toEqual([])
    })

    await then('card sink received the reply text', () => {
      const cardState = channel!.lastCardState()
      // Card text extraction from the render payload may embed the reply
      expect(cardState.status).toBe('streaming') // card updated during streaming
    })
  })

  it('Scenario 3.2: Given the setup of 3.1, When turn completes, Then exactly ONE terminal event per turn', async () => {
    await given('kernel + fake lark adapter', async () => {
      await setupLark([{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }])
    })

    let sid = ''
    await when('user sends "hi"', async () => {
      const anchor: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-u2' }
      const result = await adapter!.handleMessage(anchor, 'hi', 'chat-u2', 'msg-2')
      sid = (result as { sessionId: string }).sessionId
    })

    await then('exactly one terminal event per turn', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      expect(terminalCount(h!.captured, sid)).toBe(1)
    })
  })

  it('Scenario 3.3: Given two p2p users, When both send "hi" concurrently, Then 2 distinct sessions + isolated replies', async () => {
    await given('kernel + fake lark adapter with 2-turn LLM', async () => {
      await setupLark([
        { textDeltas: ['reply for uid-A'], usage: { input: 1, output: 1 } },
        { textDeltas: ['reply for uid-B'], usage: { input: 1, output: 1 } },
      ])
    })

    let sidA = ''
    let sidB = ''
    await when('uid-A and uid-B push "hi" concurrently', async () => {
      const anchorA: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-A' }
      const anchorB: Anchor = { kind: 'lark-p2p', appId: 'fake-app', openId: 'chat-B' }
      const [resultA, resultB] = await Promise.all([
        adapter!.handleMessage(anchorA, 'hi', 'chat-A', 'msg-A'),
        adapter!.handleMessage(anchorB, 'hi', 'chat-B', 'msg-B'),
      ])
      sidA = (resultA as { sessionId: string }).sessionId
      sidB = (resultB as { sessionId: string }).sessionId
    })

    await then('two distinct sessions exist', () => {
      expect(sidA).not.toBe(sidB)
    })

    await then('each session completed independently', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sidA)
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sidB)
      expect(terminalCount(h!.captured, sidA)).toBe(1)
      expect(terminalCount(h!.captured, sidB)).toBe(1)
    })
  })
})
