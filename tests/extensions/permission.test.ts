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

describe('permission extension', () => {
  it('should expose permission.checker capability and deny blocked tools', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    const checker = k.ctx.extensions.get('permission.checker')
    expect(checker).toBeDefined()
    expect(typeof checker.check).toBe('function')
    expect(typeof checker.deny).toBe('function')
    expect(typeof checker.allowOnce).toBe('function')

    // Default: all tools allowed
    expect(checker.check('bash')).toBe(true)
    expect(checker.check('read')).toBe(true)

    // Deny a tool
    checker.deny('bash')
    expect(checker.check('bash')).toBe(false)

    // Other tools still allowed
    expect(checker.check('read')).toBe(true)

    await k.stop()
  })

  it('should emit permission.required for dangerous tools (write) via onToolCall pre-intercept', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 5000 },
    })
    await k.start()

    let busEvents: unknown[] = []
    k.ctx.bus.on('permission.required', (payload) => {
      busEvents.push(payload)
      // Auto-approve so dispatch doesn't hang
      const env = payload as { payload: { reqId: string } }
      k.ctx.rpc.resolve('permission.resolve')!({ reqId: env.payload.reqId, decision: 'allow' })
    })

    // Dispatch onToolCall for write (dangerous)
    await k.ctx.hooks.dispatch(
      'onToolCall',
      { name: 'write', id: 'call-1' },
      { sessionId: 'main' },
    )

    expect(busEvents).toHaveLength(1)

    const firstEnv = busEvents[0] as { payload: { reqId: string; toolName: string; sessionId: string } }
    expect(firstEnv.payload.toolName).toBe('write')
    expect(firstEnv.payload.sessionId).toBe('main')
    expect(firstEnv.payload.reqId).toMatch(/^perm-/)

    await k.stop()
  })

  it('should allow safe tools (read) without permission request via onToolCall pre-intercept', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    let permissionRequests = 0
    k.ctx.bus.on('permission.required', () => {
      permissionRequests++
    })

    // Dispatch onToolCall for read (safe tool)
    await k.ctx.hooks.dispatch(
      'onToolCall',
      { name: 'read', id: 'call-1' },
      { sessionId: 'main' },
    )

    // No permission request should have been emitted
    expect(permissionRequests).toBe(0)

    await k.stop()
  })

  it('should add tool to session allowlist via permission.resolve RPC', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    const checker = k.ctx.extensions.get('permission.checker')

    // Before resolution, tool is not in allowlist
    checker.allowOnce('main', 'bash')
    expect(checker.check('bash', 'main')).toBe(true)

    // Resolve via RPC
    const result = (await k.ctx.rpc.resolve('permission.resolve')!({
      decision: 'allow',
      sessionId: 'main',
      toolName: 'write',
    })) as { ok?: boolean }

    expect(result).toBeDefined()
    expect(result.ok).toBe(true)

    // write should now be allowed in session 'main'
    expect(checker.check('write', 'main')).toBe(true)

    await k.stop()
  })

  it('should throw when denied tool is used via onToolCall', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
    })
    await k.start()

    const checker = k.ctx.extensions.get('permission.checker')
    checker.deny('bash')

    // Dispatch onToolCall for a denied tool — should throw
    let error: Error | null = null
    try {
      await k.ctx.hooks.dispatch(
        'onToolCall',
        { name: 'bash', id: 'call-1' },
        { sessionId: 'main' },
      )
    } catch (err) {
      error = err as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toContain('denied by policy')
    expect(error!.message).toContain('bash')

    await k.stop()
  })

  it('should block execution until permission.resolve is called with reqId', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 5000 },
    })
    await k.start()

    // Bus listener simulates frontend responding to permission popup
    k.ctx.bus.on('permission.required', (payload) => {
      const env = payload as { payload: { reqId: string } }
      k.ctx.rpc.resolve('permission.resolve')!({ reqId: env.payload.reqId, decision: 'allow' })
    })

    const result = await k.ctx.hooks.dispatch(
      'onToolCall',
      { name: 'bash', id: 'call-1' },
      { sessionId: 'main' },
    )

    expect(result).toEqual({ name: 'bash', id: 'call-1' })
    await k.stop()
  })

  it('should auto-deny after timeout when no response is received', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 50 },
    })
    await k.start()

    let error: Error | null = null
    try {
      await k.ctx.hooks.dispatch(
        'onToolCall',
        { name: 'write', id: 'call-2' },
        { sessionId: 'main' },
      )
    } catch (err) {
      error = err as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toContain('timeout')
    expect(error!.message).toContain('write')

    await k.stop()
  })

  it('should deny when permission.resolve is called with decision deny', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), permissionExt()],
      config: { permissionTimeoutMs: 5000 },
    })
    await k.start()

    // Bus listener responds with deny
    k.ctx.bus.on('permission.required', (payload) => {
      const env = payload as { payload: { reqId: string; toolName: string } }
      k.ctx.rpc.resolve('permission.resolve')!({
        reqId: env.payload.reqId,
        decision: 'deny',
        toolName: env.payload.toolName,
      })
    })

    let error: Error | null = null
    try {
      await k.ctx.hooks.dispatch(
        'onToolCall',
        { name: 'write', id: 'call-3' },
        { sessionId: 'main' },
      )
    } catch (err) {
      error = err as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toContain('denied by user')

    await k.stop()
  })
})
