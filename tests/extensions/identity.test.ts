import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTestKernel } from '../helpers/kernel-helper'
import identityExt from '../../src/extensions/identity'

import traceExt from '../../src/extensions/trace'
import type { FileBackedIdentityStore, IdentitySnapshot } from '../../src/infrastructure/identity/file-backed-identity-store'
import type { IdentityDiff } from '../../src/domain/identity'

describe('identity extension', () => {
  // Each test gets a unique temp dir to prevent file-backed identity store leaks
  async function tempAgentDir(agentId: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), `identity-test-${agentId}-`))
    return path.join(dir, agentId)
  }

  it('should expose identity.store capability after start', async () => {
    const agentDir = await tempAgentDir('test')
    const k = createTestKernel({ agentDir, extensions: [identityExt()] })
    await k.start()

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    expect(store).toBeDefined()
    expect(typeof store.current).toBe('function')
    expect(typeof store.update).toBe('function')
    expect(typeof store.getVersion).toBe('function')
    expect(typeof store.getHistory).toBe('function')
    expect(typeof store.rollback).toBe('function')
    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should inject identity section into system prompt', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    const prompt = {
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'hello' },
      ],
    }
    await k.ctx.hooks.dispatch('transformPrompt', prompt)

    expect(prompt.system).toContain('<identity>')
    expect(prompt.system).toContain('</identity>')
    expect(prompt.system).toContain('role: AI assistant')
    expect(prompt.system).toContain('style: helpful, concise')
    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should update identity via RPC and emit identity.changed bus event', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    let busEvent: unknown = null
    k.ctx.bus.on('identity.changed', (payload) => {
      busEvent = payload
    })

    // Call the RPC to update identity
    const result = (await k.ctx.rpc.resolve('identity.set')!({ changes: { role: 'code reviewer', style: 'strict, detailed' } })) as { effectiveFrom: string }

    expect(result.effectiveFrom).toBe('next-turn')

    // Bus event emitted (wrapped in EventEnvelope)
    expect(busEvent).not.toBeNull()
    const env = busEvent as { payload: Record<string, unknown> }
    expect(env.payload.fromVersion).toBe(1)
    expect(env.payload.toVersion).toBe(2)
    expect(env.payload.changes).toMatchObject({
      role: { from: 'AI assistant', to: 'code reviewer' },
      style: { from: 'helpful, concise', to: 'strict, detailed' },
    })

    // Verify store was updated
    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    const identity = store.current()
    expect(identity.fields.role).toBe('code reviewer')
    expect(identity.fields.style).toBe('strict, detailed')
    expect(identity.version).toBe(2)

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should return current identity via RPC identity.get', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    const result = (await k.ctx.rpc.resolve('identity.get')!({})) as { identity: IdentitySnapshot }

    expect(result).toBeDefined()
    expect(result.identity).toBeDefined()
    expect(result.identity.agentId).toBe('user-1')
    expect(result.identity.version).toBe(1)
    expect(result.identity.fields).toMatchObject({
      role: 'AI assistant',
      style: 'helpful, concise',
    })

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should have monotonic version after multiple updates', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    // Update three times
    for (let i = 0; i < 3; i++) {
      await k.ctx.rpc.resolve('identity.set')!({ changes: { iteration: String(i) } })
    }

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    expect(store.getVersion()).toBe(4) // started at 1, +3 updates
    expect(store.current().version).toBe(4)
    expect(store.current().fields.iteration).toBe('2') // last value

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should track version history via getHistory', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    // Apply several changes
    await k.ctx.rpc.resolve('identity.set')!({ changes: { role: 'reviewer' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { style: 'terse' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { tone: 'professional' } })

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    const history = store.getHistory()

    expect(history).toHaveLength(3)
    expect(history[0].fromVersion).toBe(1)
    expect(history[0].toVersion).toBe(2)
    expect(history[0].changes).toMatchObject({
      role: { from: 'AI assistant', to: 'reviewer' },
    })
    expect(history[1].fromVersion).toBe(2)
    expect(history[1].toVersion).toBe(3)
    expect(history[2].fromVersion).toBe(3)
    expect(history[2].toVersion).toBe(4)

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should return history via identity.history RPC', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    await k.ctx.rpc.resolve('identity.set')!({ changes: { role: 'reviewer' } })

    const result = (await k.ctx.rpc.resolve('identity.history')!({})) as { history: IdentityDiff[] }
    expect(result.history).toHaveLength(1)
    expect(result.history[0].fromVersion).toBe(1)
    expect(result.history[0].toVersion).toBe(2)

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should rollback to a previous version and restore content', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    // Apply changes across several versions
    await k.ctx.rpc.resolve('identity.set')!({ changes: { role: 'reviewer' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { style: 'terse' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { tone: 'professional' } })

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    expect(store.getVersion()).toBe(4)

    // Rollback to version 2
    const result = (await k.ctx.rpc.resolve('identity.rollback')!({ targetVersion: 2 })) as {
      effectiveFrom?: string
      version?: number
      error?: string
    }

    expect(result.error).toBeUndefined()
    expect(result.effectiveFrom).toBe('next-turn')
    expect(result.version).toBe(2)

    // Verify content was restored
    const identity = store.current()
    expect(identity.version).toBe(2)
    expect(identity.fields.role).toBe('reviewer') // set at v2, preserved
    expect(identity.fields.style).toBe('helpful, concise') // reverted to original
    expect(identity.fields.tone).toBeUndefined() // was added at v4, reverted

    // History should be trimmed
    const history = store.getHistory()
    expect(history).toHaveLength(1) // only the v1→v2 diff remains
    expect(history[0].toVersion).toBe(2)

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should throw when rolling back to future or current version', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    await k.ctx.rpc.resolve('identity.set')!({ changes: { role: 'reviewer' } })

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    expect(store.getVersion()).toBe(2)

    // Try to rollback to current version (should fail)
    const result1 = (await k.ctx.rpc.resolve('identity.rollback')!({ targetVersion: 2 })) as { error?: string }
    expect(result1.error).toBeDefined()
    expect(result1.error!).toContain('must be less than current version')

    // Try to rollback to future version (should fail)
    const result2 = (await k.ctx.rpc.resolve('identity.rollback')!({ targetVersion: 5 })) as { error?: string }
    expect(result2.error).toBeDefined()
    expect(result2.error!).toContain('must be less than current version')

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })

  it('should maintain monotonic version after rollback and subsequent updates', async () => {
    const agentDir = await tempAgentDir('user-1')
    const k = createTestKernel({
      agentId: 'user-1',
      agentDir,
      extensions: [identityExt()],
    })
    await k.start()

    // Go to version 4
    await k.ctx.rpc.resolve('identity.set')!({ changes: { a: '1' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { b: '2' } })
    await k.ctx.rpc.resolve('identity.set')!({ changes: { c: '3' } })

    // Rollback to version 2
    await k.ctx.rpc.resolve('identity.rollback')!({ targetVersion: 2 })

    const store = k.ctx.extensions.get<FileBackedIdentityStore>('identity.store')
    expect(store.getVersion()).toBe(2)

    // New update should produce version 3 (not 5)
    await k.ctx.rpc.resolve('identity.set')!({ changes: { d: '4' } })
    expect(store.getVersion()).toBe(3)
    expect(store.current().fields.d).toBe('4')
    expect(store.current().fields.b).toBeUndefined() // reverted by rollback

    await k.stop()
    await rm(path.dirname(agentDir), { recursive: true, force: true }).catch(() => {})
  })
})

// transformPrompt pipeline order test removed from this file.
// Memory no longer registers transformPrompt hook (per Spec-10b).
// Identity will call memory.recall directly in Spec-10c.
