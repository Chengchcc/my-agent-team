import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKernel } from '../../src/kernel/kernel'
import controlplaneExt from '../../src/extensions/controlplane'
import dataplaneExt from '../../src/extensions/dataplane'
import { transportUnix } from '../../src/extensions/transport.unix'

describe('transport.unix extension', () => {
  const testDirs: string[] = []

  afterEach(async () => {
    for (const d of testDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    testDirs.length = 0
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'transport-unix-test-'))
    testDirs.push(dir)
    return dir
  }

  it('normal lifecycle: listen on kernelReady, close on kernel.stop', async () => {
    const agentDir = await tempDir()
    const socketPath = path.join(agentDir, 'daemon.sock')

    const kernel = createKernel({ agentId: 'lifecycle', agentDir })
    kernel.use(controlplaneExt())
    kernel.use(dataplaneExt())
    kernel.use(transportUnix({ socketPath }))
    await kernel.start()

    // Socket should be created after kernelReady
    await access(socketPath)
    // PID file should exist
    await access(socketPath + '.pid')

    await kernel.stop()

    // Socket and pid should be cleaned up after stop
    await expect(access(socketPath)).rejects.toThrow()
    await expect(access(socketPath + '.pid')).rejects.toThrow()
  })

  it('idempotent double close', async () => {
    const agentDir = await tempDir()
    const socketPath = path.join(agentDir, 'daemon.sock')

    const kernel = createKernel({ agentId: 'idempotent', agentDir })
    kernel.use(controlplaneExt())
    kernel.use(dataplaneExt())
    kernel.use(transportUnix({ socketPath }))
    await kernel.start()

    await kernel.stop()
    // Second stop should not throw
    await kernel.stop()
  })

  it('two different agentId concurrent start — sockets do not conflict', async () => {
    const profileDirA = await tempDir()
    const profileDirB = await tempDir()
    const sockA = path.join(profileDirA, 'daemon.sock')
    const sockB = path.join(profileDirB, 'daemon.sock')

    const kA = createKernel({ agentId: 'alpha', agentDir: profileDirA })
    kA.use(controlplaneExt())
    kA.use(dataplaneExt())
    kA.use(transportUnix({ socketPath: sockA }))

    const kB = createKernel({ agentId: 'beta', agentDir: profileDirB })
    kB.use(controlplaneExt())
    kB.use(dataplaneExt())
    kB.use(transportUnix({ socketPath: sockB }))

    await Promise.all([kA.start(), kB.start()])

    await access(sockA)
    await access(sockB)

    await Promise.all([kA.stop(), kB.stop()])

    await expect(access(sockA)).rejects.toThrow()
    await expect(access(sockB)).rejects.toThrow()
  })

  it('stale socket file — cleaned on startup', async () => {
    const agentDir = await tempDir()
    const socketPath = path.join(agentDir, 'daemon.sock')

    // Create a fake stale socket file
    await import('node:fs/promises').then(fs => fs.mkdir(agentDir, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(socketPath, 'stale'))

    const kernel = createKernel({ agentId: 'stale-clean', agentDir })
    kernel.use(controlplaneExt())
    kernel.use(dataplaneExt())
    kernel.use(transportUnix({ socketPath }))

    // Should start without EADDRINUSE
    await kernel.start()
    await access(socketPath)

    await kernel.stop()
  })
})
