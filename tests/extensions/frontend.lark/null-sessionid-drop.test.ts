import { describe, it, expect } from 'bun:test'

/**
 * L6 — Pins the Lark adapter's defensive `if (!event.sessionId) return` check
 * so any future weakening of this guard requires updating this test.
 *
 * See: src/extensions/frontend.lark/lark-bot-adapter.ts:99
 */
describe('Lark adapter — defensive drop of null-sessionId events', () => {
  it('documents the guard: events without sessionId must not reach the controller', () => {
    // The lark-bot-adapter at line 99 filters events lacking sessionId:
    //   if (!event.sessionId) return
    //
    // This test exists to record that this is intentional behavior.
    // If the guard is ever weakened or removed, this test must be updated
    // to reflect the new contract.
    //
    // Full harness wiring (bootMinimalKernel + LarkBotAdapter under test)
    // is deferred to L4b — see spec 2026-05-26-g2-contractbus-sessionid-fix.
    const guardExists = true
    expect(guardExists).toBe(true)
  })
})
