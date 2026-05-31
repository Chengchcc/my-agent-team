import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrap } from '../../src/interface/daemon/main'
import type { DaemonOptions } from '../../src/interface/daemon/types'

// Ensure tests use EchoProvider — real API keys in the environment would
// trigger network calls (10+ seconds) during evolution drainer tasks.
const SAVED_ENV: Record<string, string | undefined> = {}

describe('daemon bootstrap', () => {
  const testDirs: string[] = []

  beforeAll(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      SAVED_ENV[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterAll(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      if (SAVED_ENV[key] !== undefined) {
        process.env[key] = SAVED_ENV[key]
      }
    }
  })

  afterEach(async () => {
    for (const d of testDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    testDirs.length = 0
  })

  async function tempProfileRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'daemon-bootstrap-test-'))
    testDirs.push(dir)
    return dir
  }

  it('bootstrap with inmem transport → handle.stop should complete', async () => {
    const agentsRoot = await tempProfileRoot()
    // Use 'default' agentId so it gets auto-seeded by the daemon gate
    process.env.MY_AGENT_HOME = agentsRoot
    const opts: DaemonOptions = {
      agentId: 'default',
      agentsRoot,
      transport: 'inmem',
    }

    const handle = await bootstrap(opts)

    expect(handle.agentDir).toBe(path.join(agentsRoot, 'default'))
    expect(handle.socketPath).toBe(path.join(agentsRoot, 'default', 'daemon.sock'))
    expect(handle.kernel).toBeDefined()
    expect(typeof handle.stop).toBe('function')

    await handle.stop()
    // Second stop should be idempotent
    await handle.stop()
    delete process.env.MY_AGENT_HOME
  })

  it('bootstrap should create profile directory automatically', async () => {
    const agentsRoot = await tempProfileRoot()
    process.env.MY_AGENT_HOME = agentsRoot
    const opts: DaemonOptions = {
      agentId: 'default',
      agentsRoot,
      transport: 'inmem',
    }

    const handle = await bootstrap(opts)
    const { stat } = await import('node:fs/promises')
    const s = await stat(handle.agentDir)
    expect(s.isDirectory()).toBe(true)
    await handle.stop()
    delete process.env.MY_AGENT_HOME
  })

  it('bootstrap should reject socket paths beyond sun_path limit', async () => {
    const agentsRoot = await tempProfileRoot()
    // Create a path that exceeds 103 bytes
    const veryLong = 'a'.repeat(100)
    const opts: DaemonOptions = {
      agentId: veryLong,
      agentsRoot,
      transport: 'inmem',
    }

    await expect(bootstrap(opts)).rejects.toThrow('Socket path too long')
  })
})
