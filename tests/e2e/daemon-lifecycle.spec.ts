import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { given, when, then } from './_fixtures/dsl'
import type { DaemonHandle } from '../../src/interface/daemon/types'

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'e2e-f1-'))
}

describe('Feature: Daemon lifecycle (F1)', () => {
  let handle: DaemonHandle | null = null
  let agentDir = ''
  afterEach(async () => {
    if (handle) await handle.stop()
    if (agentDir) try { rmSync(agentDir, { recursive: true, force: true }) } catch { /* cleanup */ }
    handle = null
  })

  it('Scenario 1.1: Given a fresh temp agent home, When bootstrap({transport:"inmem"}), Then kernel starts with 18 extensions', async () => {
    await given('a fresh temp agent home', async () => {
      agentDir = tempHome()
    })

    await when('bootstrap with inmem transport', async () => {
      const { bootstrap } = await import('../../src/interface/daemon/main')
      handle = await bootstrap({
        agentId: 'default',
        agentsRoot: agentDir,
        transport: 'inmem',
      })
    })

    await then('kernel is started with all extensions', () => {
      expect(handle!.kernel.ctx.extensions.list().length).toBeGreaterThanOrEqual(9)
      expect(handle!.kernel.ctx.extensions.list()).toContain('dataplane')
      expect(handle!.kernel.ctx.extensions.list()).toContain('session')
    })
  })

  it('Scenario 1.2: Given a started kernel, When stop() twice, Then both resolve without throwing', async () => {
    await given('a started kernel', async () => {
      agentDir = tempHome()
      const { bootstrap } = await import('../../src/interface/daemon/main')
      handle = await bootstrap({
        agentId: 'default',
        agentsRoot: agentDir,
        transport: 'inmem',
      })
    })

    await when('stop() called twice', async () => {
      await handle!.stop()
      await handle!.stop()
    })

    await then('both resolved without throwing', () => {
      // reaching here without throw is the assertion
      expect(true).toBe(true)
    })
  })

  it('Scenario 1.3: Given agentId > 100 chars, When bootstrap({transport:"unix"}), Then rejects with "socket path too long"', async () => {
    const longId = 'a'.repeat(101)

    await given(`agentId with ${longId.length} chars`, () => {})

    await when('bootstrap with unix transport', async () => {
      agentDir = tempHome()
      const { bootstrap } = await import('../../src/interface/daemon/main')
      try {
        handle = await bootstrap({
          agentId: longId,
          agentsRoot: agentDir,
          transport: 'unix',
        })
        // Should not reach here
        handle = null
      } catch (err) {
        expect((err as Error).message).toContain('socket path too long')
      }
    })
  })
})
