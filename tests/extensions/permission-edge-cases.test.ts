import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import sessionExt from '../../src/extensions/session'
import traceExt from '../../src/extensions/trace'
import permissionExt from '../../src/extensions/permission'

interface PermissionChecker {
  check: (toolName: string, sessionId?: string) => boolean
  deny: (toolName: string) => void
  allowOnce: (sessionId: string, toolName: string) => void
}

describe('permission edge cases', () => {
  // ── DESIGN.md gap #7: per-session isolation ──

  it('allowOnce in session A does not affect session B', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    const checker = k.ctx.extensions.get('permission.checker')

    checker.allowOnce('session-a', 'bash')
    expect(checker.check('bash', 'session-a')).toBe(true)
    expect(checker.check('bash', 'session-b')).toBe(true) // no allowlist for session-b
    expect(checker.check('bash')).toBe(true) // no session → no restriction

    await k.stop()
  })

  it('checks session allowlist: tool not in allowlist is denied via onToolCall', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    // Set up an allowlist for session-a that allows only 'read'
    const checker = k.ctx.extensions.get('permission.checker')
    checker.allowOnce('session-a', 'read')

    // read in session-a: allowed
    const readResult = await k.ctx.hooks.dispatch(
      'onToolCall',
      { name: 'read', id: 'r1' },
      { sessionId: 'session-a' },
    )
    expect(readResult).toEqual({ name: 'read', id: 'r1' })

    // bash in session-a: denied (not in allowlist)
    let error: Error | null = null
    try {
      await k.ctx.hooks.dispatch(
        'onToolCall',
        { name: 'bash', id: 'b1' },
        { sessionId: 'session-a' },
      )
    } catch (err) {
      error = err as Error
    }
    expect(error).not.toBeNull()
    expect(error!.message).toContain('not allowed in session')

    await k.stop()
  })

  // ── DESIGN.md gap #7: concurrent write requests get distinct reqIds ──

  it('concurrent write requests each get a distinct reqId', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 5000 },
    })
    await k.start()

    const reqIds: string[] = []
    k.ctx.bus.on('permission.required', (payload) => {
      const env = payload as { payload: { reqId: string } }
      reqIds.push(env.payload.reqId)
      // Approve immediately
      k.ctx.rpc.resolve('permission.resolve')!({ reqId: env.payload.reqId, decision: 'allow' })
    })

    // Dispatch two writes concurrently
    await Promise.all([
      k.ctx.hooks.dispatch('onToolCall', { name: 'write', id: 'w1' }, { sessionId: 'main' }),
      k.ctx.hooks.dispatch('onToolCall', { name: 'write', id: 'w2' }, { sessionId: 'main' }),
    ])

    expect(reqIds).toHaveLength(2)
    expect(reqIds[0]).not.toBe(reqIds[1])

    await k.stop()
  })

  // ── dispose cleanup ──

  it('pending requests are rejected on dispose (no hanging promises)', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 30000 }, // long timeout, won't fire naturally
    })
    await k.start()

    // Start a write call — don't resolve it
    let writeError: Error | null = null
    const writePromise = k.ctx.hooks.dispatch(
      'onToolCall',
      { name: 'write', id: 'w-dispose' },
      { sessionId: 'main' },
    ).catch((err: Error) => { writeError = err })

    // Stop the kernel (triggers dispose)
    await k.stop()

    // The pending write should have been rejected
    await writePromise
    expect(writeError).not.toBeNull()
    expect(writeError!.message).toContain('disposed')
  })
})
