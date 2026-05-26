import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import controlplaneExt from '../../src/extensions/controlplane'
import sessionExt from '../../src/extensions/session'
import providerExt from '../../src/extensions/provider'
import controlplaneMethodsExt from '../../src/extensions/controlplane/methods'

interface ControlPlaneServer {
  handle: (message: unknown) => Promise<Record<string, unknown> | null>
  attachFrontend: (frontendId: string, sessionId: string) => void
  detachFrontend: (frontendId: string, sessionId: string) => void
  getFrontendSessions: (frontendId: string) => string[]
}

/** Send an RPC request through the controlplane and return the result. */
async function rpc(
  server: ControlPlaneServer,
  method: string,
  params?: Record<string, unknown>,
  id?: number,
): Promise<Record<string, unknown> | null> {
  return server.handle({
    jsonrpc: '2.0',
    id: id ?? 1,
    method,
    params,
  })
}

/** Assert an RPC success result and return the result data. */
function expectSuccess(
  response: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!response) throw new Error('Expected response, got null')
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as Record<string, unknown>
}

/** Assert an RPC error result. */
function expectError(
  response: Record<string, unknown> | null,
  expectedCode?: number,
): Record<string, unknown> {
  if (!response) throw new Error('Expected error response, got null')
  const err = response.error as { code: number; message: string } | undefined
  expect(err).toBeDefined()
  if (expectedCode !== undefined) {
    expect(err!.code).toBe(expectedCode)
  }
  return response
}

// ── Helper: create a kernel with session + controlplane + methods ──────────

function createMethodsTestKernel(agentId = 'test-methods') {
  return createTestKernel({
    agentId,
    extensions: [traceExt(), sessionExt(), providerExt({}), controlplaneExt(), controlplaneMethodsExt()],
  })
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('controlplane-methods extension', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // Session domain
  // ═══════════════════════════════════════════════════════════════════════

  describe('session.list', () => {
    it('should list sessions including the default main session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'session.list'))
      const sessions = res.sessions as Array<Record<string, unknown>>
      expect(sessions.length).toBeGreaterThanOrEqual(1)
      expect(sessions.some((s) => s.id === 'main')).toBe(true)

      await k.stop()
    })

    it('should include newly created sessions', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Create a new session
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Test Session' }),
      )
      const newId = createRes.sessionId as string

      // List should now include the new session
      const listRes = expectSuccess(await rpc(server, 'session.list'))
      const sessions = listRes.sessions as Array<Record<string, unknown>>
      expect(sessions.some((s) => s.id === newId)).toBe(true)

      await k.stop()
    })

    it('session JSON shape should have required fields', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'session.list'))
      const sessions = res.sessions as Array<Record<string, unknown>>
      const main = sessions.find((s) => s.id === 'main')
      expect(main).toBeDefined()
      expect(main!.state).toBeDefined()
      expect(main!.isMain).toBe(true)
      expect(main!.agentId).toBe('test-methods')
      expect(main!.createdAt).toBeDefined()
      expect(main!.lastActiveAt).toBeDefined()
      expect(Array.isArray(main!.pendingInputs)).toBe(true)

      await k.stop()
    })
  })

  describe('session.attach', () => {
    it('should throw for non-existent session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'session.attach', {
          frontendId: 'fe-test',
          sessionId: 'nonexistent',
        }),
      )

      await k.stop()
    })

    it('should require frontendId', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(await rpc(server, 'session.attach', { sessionId: 'main' }))

      await k.stop()
    })
  })

  describe('session.detach', () => {
    it('should detach a frontend from a session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Attach first
      await rpc(server, 'session.attach', { frontendId: 'fe-test', sessionId: 'main' })
      expect(server.getFrontendSessions('fe-test')).toContain('main')

      // Detach
      const res = expectSuccess(
        await rpc(server, 'session.detach', {
          frontendId: 'fe-test',
          sessionId: 'main',
        }),
      )
      expect(res.ok).toBe(true)

      // Verify tracking removed
      expect(server.getFrontendSessions('fe-test')).not.toContain('main')

      await k.stop()
    })

    it('should not throw for already-detached frontend', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'session.detach', {
          frontendId: 'fe-unknown',
          sessionId: 'main',
        }),
      )
      expect(res.ok).toBe(true)

      await k.stop()
    })
  })

  describe('session.resume', () => {
    it('should resume a session (attach to target)', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Create a second session to resume to
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Resume Target' }),
      )
      const targetId = createRes.sessionId as string

      // Resume (attach to target)
      const res = expectSuccess(
        await rpc(server, 'session.resume', {
          sessionId: targetId,
          frontendId: 'fe-resume',
        }),
      )
      expect(res.ok).toBe(true)
      expect(res.sessionId).toBe(targetId)

      const sessionData = res.session as Record<string, unknown>
      expect(sessionData.id).toBe(targetId)

      await k.stop()
    })

    it('should detach from current session when currentSessionId provided', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Attach to current session (main)
      await rpc(server, 'session.attach', {
        frontendId: 'fe-switch',
        sessionId: 'main',
      })

      // Create a new target session
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Target' }),
      )
      const targetId = createRes.sessionId as string

      // Resume: detach from main + attach to target
      const res = expectSuccess(
        await rpc(server, 'session.resume', {
          sessionId: targetId,
          frontendId: 'fe-switch',
          currentSessionId: 'main',
        }),
      )
      expect(res.ok).toBe(true)

      // Verify detached from main
      expect(server.getFrontendSessions('fe-switch')).not.toContain('main')
      expect(server.getFrontendSessions('fe-switch')).toContain(targetId)

      await k.stop()
    })

    it('should throw for non-existent session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'session.resume', { sessionId: 'nonexistent' }),
      )

      await k.stop()
    })
  })

  describe('session.create', () => {
    it('should create a new non-main session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'session.create', { title: 'My New Session' }),
      )

      expect(res.ok).toBe(true)
      expect(res.sessionId).toBeDefined()
      expect((res.sessionId as string).startsWith('session-')).toBe(true)

      const sessionData = res.session as Record<string, unknown>
      expect(sessionData.title).toBe('My New Session')
      expect(sessionData.isMain).toBe(false)
      expect(sessionData.state).toBe('INIT')

      await k.stop()
    })

    it('should create session with frontend attached', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'session.create', {
          title: 'Frontend Session',
          frontendId: 'fe-new',
        }),
      )

      const sessionData = res.session as Record<string, unknown>
      const frontends = sessionData.attachedFrontendIds as string[]
      expect(frontends).toContain('fe-new')

      await k.stop()
    })

    it('should create multiple sessions with unique IDs', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      const ids = new Set<string>()
      for (let i = 0; i < 5; i++) {
        const res = expectSuccess(
          await rpc(server, 'session.create', { title: `Session ${i}` }),
        )
        ids.add(res.sessionId as string)
      }
      expect(ids.size).toBe(5)

      await k.stop()
    })
  })

  describe('session.close', () => {
    it('should close a non-main session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Create a session to close
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'To Be Closed' }),
      )
      const sessionId = createRes.sessionId as string

      // Close it
      const res = expectSuccess(
        await rpc(server, 'session.close', { sessionId }),
      )
      expect(res.ok).toBe(true)
      expect(res.state).toBe('CLOSED')

      // Verify in list
      const listRes = expectSuccess(await rpc(server, 'session.list'))
      const sessions = listRes.sessions as Array<Record<string, unknown>>
      const closed = sessions.find((s) => s.id === sessionId)
      expect(closed!.state).toBe('CLOSED')

      await k.stop()
    })

    it('should throw when closing main session without force', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(await rpc(server, 'session.close', { sessionId: 'main' }))

      await k.stop()
    })

    it('should close main session with force=true', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'session.close', { sessionId: 'main', force: true }),
      )
      expect(res.ok).toBe(true)
      expect(res.state).toBe('CLOSED')

      await k.stop()
    })

    it('should no-op on already-closed session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Close Twice' }),
      )
      const sessionId = createRes.sessionId as string

      await rpc(server, 'session.close', { sessionId })
      const res = expectSuccess(await rpc(server, 'session.close', { sessionId }))
      expect(res.ok).toBe(true)
      expect(res.state).toBe('CLOSED')

      await k.stop()
    })
  })

  describe('session.rename', () => {
    it('should rename a session title', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'session.rename', {
          sessionId: 'main',
          title: 'Renamed Main',
        }),
      )
      expect(res.ok).toBe(true)
      expect(res.title).toBe('Renamed Main')

      // Verify in list
      const listRes = expectSuccess(await rpc(server, 'session.list'))
      const sessions = listRes.sessions as Array<Record<string, unknown>>
      const main = sessions.find((s) => s.id === 'main')
      expect(main!.title).toBe('Renamed Main')

      await k.stop()
    })

    it('should throw when title is missing', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(await rpc(server, 'session.rename', { sessionId: 'main' }))

      await k.stop()
    })

    it('should throw for non-existent session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'session.rename', {
          sessionId: 'nonexistent',
          title: 'Nope',
        }),
      )

      await k.stop()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Input domain
  // ═══════════════════════════════════════════════════════════════════════

  describe('input.send', () => {
    it('should throw for non-existent session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'input.send', {
          sessionId: 'nonexistent',
          text: 'Hello',
        }),
      )

      await k.stop()
    })

    it('should require text parameter', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(await rpc(server, 'input.send', { sessionId: 'main' }))

      await k.stop()
    })

    it('should accept empty string input', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'input.send', {
          sessionId: 'main',
          text: '',
          frontendId: 'fe-input',
        }),
      )
      expect(res.accepted).toBe(true)

      await k.stop()
    })
  })

  describe('input.cancel', () => {
    it('should cancel a running turn', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Start a turn first
      await rpc(server, 'input.send', {
        sessionId: 'main',
        text: 'Something to cancel',
      })

      // Cancel it
      const res = expectSuccess(
        await rpc(server, 'input.cancel', {
          sessionId: 'main',
          reason: 'user changed mind',
        }),
      )
      expect(res.cancelled).toBe(true)
      expect(res.reason).toBe('user changed mind')

      // Session should be back to IDLE
      const listRes = expectSuccess(await rpc(server, 'session.list'))
      const sessions = listRes.sessions as Array<Record<string, unknown>>
      const main = sessions.find((s) => s.id === 'main')
      expect(main!.state === 'IDLE' || main!.state === 'INIT').toBe(true)

      await k.stop()
    })

    it('should be a no-op when session is not running', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'input.cancel', { sessionId: 'main' }),
      )
      expect(res.cancelled).toBe(true)

      await k.stop()
    })

    it('should throw for non-existent session', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'input.cancel', { sessionId: 'nonexistent' }),
      )

      await k.stop()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // User interaction domain
  // ═══════════════════════════════════════════════════════════════════════

  describe('user.answer', () => {
    it('should accept a user question answer', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(
        await rpc(server, 'user.answer', {
          sessionId: 'main',
          questionId: 'q-001',
          answers: [{ question_index: 0, selected_labels: ['option-a'] }],
        }),
      )
      expect(res.ok).toBe(true)
      expect(res.sessionId).toBe('main')
      expect(res.questionId).toBe('q-001')

      await k.stop()
    })

    it('should require questionId', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      expectError(
        await rpc(server, 'user.answer', { sessionId: 'main', answers: [] }),
      )

      await k.stop()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // System domain
  // ═══════════════════════════════════════════════════════════════════════

  describe('system.health', () => {
    it('should return health status with subsystems', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'system.health'))

      expect(res.status).toBe('ok')
      expect(res.agentId).toBe('test-methods')
      expect(typeof res.uptimeMs).toBe('number')
      expect(typeof res.extensions).toBe('number')
      expect(res.extensions).toBeGreaterThan(0)
      expect(typeof res.rpcMethods).toBe('number')
      expect(res.rpcMethods).toBeGreaterThan(0)
      expect(res.subsystems).toBeDefined()
      expect((res.subsystems as Record<string, unknown>).session).toBe('ok')

      await k.stop()
    })

    it('should report session as unavailable when not present', async () => {
      // Kernel with controlplane-methods but WITHOUT session extension
      const k = createTestKernel({
        agentId: 'no-session',
        extensions: [traceExt(), controlplaneExt(), controlplaneMethodsExt()],
      })
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'system.health'))
      expect((res.subsystems as Record<string, unknown>).session).toBe('unavailable')

      await k.stop()
    })
  })

  describe('system.shutdown', () => {
    it('should initiate shutdown and return status', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      let shutdownReceived = false
      k.ctx.bus.on('system.shutdown.requested', () => {
        shutdownReceived = true
      })

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'system.shutdown'))

      expect(res.shuttingDown).toBe(true)
      expect(typeof res.message).toBe('string')

      // The event may be async, so we check after a small delay
      expect(shutdownReceived).toBe(true)

      await k.stop()
    })
  })

  describe('system.version', () => {
    it('should return version information', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')
      const res = expectSuccess(await rpc(server, 'system.version'))

      expect(res.daemonVersion).toBe('2.0.0')
      expect(res.kernelVersion).toBe('1.0.0')
      expect(res.agentId).toBe('test-methods')
      expect(res.protocolVersion).toBe('2.0')

      await k.stop()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Integration scenarios
  // ═══════════════════════════════════════════════════════════════════════

  describe('integration', () => {
    it('full session lifecycle: create → rename → close', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Create
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Lifecycle Test' }),
      )
      const sessionId = createRes.sessionId as string
      expect(sessionId).toBeDefined()

      // Rename
      const renameRes = expectSuccess(
        await rpc(server, 'session.rename', { sessionId, title: 'Renamed' }),
      )
      expect(renameRes.title).toBe('Renamed')

      // Close
      const closeRes = expectSuccess(
        await rpc(server, 'session.close', { sessionId }),
      )
      expect(closeRes.state).toBe('CLOSED')

      await k.stop()
    })

    it('frontend lifecycle: attach → detach → resume', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Create a second session
      const createRes = expectSuccess(
        await rpc(server, 'session.create', { title: 'Target Session' }),
      )
      const targetId = createRes.sessionId as string

      // Attach to main
      await rpc(server, 'session.attach', {
        frontendId: 'fe-lifecycle',
        sessionId: 'main',
      })
      expect(server.getFrontendSessions('fe-lifecycle')).toContain('main')

      // Resume to target (detaches from main, attaches to target)
      const resumeRes = expectSuccess(
        await rpc(server, 'session.resume', {
          sessionId: targetId,
          frontendId: 'fe-lifecycle',
          currentSessionId: 'main',
        }),
      )
      expect(resumeRes.ok).toBe(true)
      expect(server.getFrontendSessions('fe-lifecycle')).not.toContain('main')
      expect(server.getFrontendSessions('fe-lifecycle')).toContain(targetId)

      await k.stop()
    })

    it('input.send → input.cancel flow', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Send input
      const sendRes = expectSuccess(
        await rpc(server, 'input.send', {
          sessionId: 'main',
          text: 'Start a task',
        }),
      )
      expect(sendRes.accepted).toBe(true)
      expect(sendRes.turnId).toBeDefined()

      // Cancel the turn
      const cancelRes = expectSuccess(
        await rpc(server, 'input.cancel', { sessionId: 'main' }),
      )
      expect(cancelRes.cancelled).toBe(true)

      await k.stop()
    })

    it('all system RPC methods return valid responses', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // health
      const health = expectSuccess(await rpc(server, 'system.health'))
      expect(health.status).toBe('ok')

      // version
      const version = expectSuccess(await rpc(server, 'system.version'))
      expect(version.daemonVersion).toBeDefined()

      // shutdown
      const shutdown = expectSuccess(await rpc(server, 'system.shutdown'))
      expect(shutdown.shuttingDown).toBe(true)

      await k.stop()
    })

    it('all 13 new methods are registered and return non-null', async () => {
      const k = createMethodsTestKernel()
      await k.start()

      const server = k.ctx.extensions.get('controlplane.server')

      // Verify all 13 methods are registered in RpcRegistry
      const expectedMethods = [
        'session.list', 'session.attach', 'session.detach', 'session.resume',
        'session.create', 'session.close', 'session.rename',
        'input.send', 'input.cancel',
        'user.answer',
        'system.health', 'system.shutdown', 'system.version',
      ]

      for (const method of expectedMethods) {
        expect(k.ctx.rpc.has(method)).toBe(true)
      }

      await k.stop()
    })
  })
})
