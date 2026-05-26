import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import sessionModeExt from '../../../src/extensions/session-mode'
import type { SessionStore } from '../../../src/application/ports/session-store'

describe('session-mode RPC (M2)', () => {
  // ── session.setMode / session.getMode ──

  it('session.setMode switches mode and session.getMode reads it', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const before = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'tui-default' }) as { mode: string }
    expect(before.mode).toBe('normal')

    const result = await k.ctx.rpc.resolve('session.setMode')!({ sessionId: 'tui-default', mode: 'plan' }) as { ok: boolean }
    expect(result.ok).toBe(true)

    const after = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'tui-default' }) as { mode: string }
    expect(after.mode).toBe('plan')

    // Verify persisted in store
    const store = k.ctx.extensions.get('session.store')
    const s = await store.load('tui-default')
    expect(s?.mode).toBe('plan')

    await k.stop()
  })

  it('session.setMode with unknown mode returns error', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const result = await k.ctx.rpc.resolve('session.setMode')!({ sessionId: 'tui-default', mode: 'nonexistent' }) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown mode')

    // Mode unchanged
    const mode = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'tui-default' }) as { mode: string }
    expect(mode.mode).toBe('normal')

    await k.stop()
  })

  // ── session.resolvePlan ──

  it('session.resolvePlan approve switches to normal', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    // Enter plan mode first
    await k.ctx.rpc.resolve('session.setMode')!({ sessionId: 'tui-default', mode: 'plan' })

    const result = await k.ctx.rpc.resolve('session.resolvePlan')!({ sessionId: 'tui-default', decision: 'approve' }) as { ok: boolean }
    expect(result.ok).toBe(true)

    const mode = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'tui-default' }) as { mode: string }
    expect(mode.mode).toBe('normal')

    await k.stop()
  })

  it('session.resolvePlan keep does not switch mode', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    await k.ctx.rpc.resolve('session.setMode')!({ sessionId: 'tui-default', mode: 'plan' })

    const result = await k.ctx.rpc.resolve('session.resolvePlan')!({ sessionId: 'tui-default', decision: 'keep' }) as { ok: boolean }
    expect(result.ok).toBe(true)

    const mode = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'tui-default' }) as { mode: string }
    expect(mode.mode).toBe('plan')

    await k.stop()
  })
})
