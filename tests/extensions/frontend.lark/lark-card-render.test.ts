import { describe, it, expect } from 'bun:test'
import type * as Lark from '@larksuiteoapi/node-sdk'
import { FakeChannel, extractTextFromCard } from '../../fixtures/fake-lark-channel'
import { TurnCardController } from '../../../src/extensions/frontend.lark/internal/turn-card-controller'
import type { DataPlaneEvent } from '../../../src/application/contracts'

const mkDelta = (sessionId: string | undefined, delta: string): DataPlaneEvent => ({
  type: 'assistant.delta', version: 1, ts: 0,
  sessionId, turnId: 'T',
  payload: { sessionId: sessionId ?? 'S', turnId: 'T', delta },
  evId: 'ev-x', cursor: 0,
})

describe('Lark TurnCardController — text accumulation', () => {
  it('renders accumulated delta text into card after finalize', async () => {
    const ch = new FakeChannel()
    const ctrl = await TurnCardController.open(ch as unknown as Lark.LarkChannel, 'chat-X', 'msg-Y')

    // These mirror what happens when dataplane delivers properly-tagged events.
    await ctrl.feed(mkDelta('S', 'Hello'))
    await ctrl.feed(mkDelta('S', ', '))
    await ctrl.feed(mkDelta('S', 'world'))
    await ctrl.finalize('done')

    const text = extractTextFromCard(ch.lastUpdatePayload)
    expect(text, `final card text was: "${text}"`).toContain('Hello, world')
  })
})
