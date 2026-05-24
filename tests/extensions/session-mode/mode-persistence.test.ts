import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import sessionModeExt from '../../../src/extensions/session-mode'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('mode persistence (M3)', () => {
  it('mode is persisted to NDJSON meta line via setMode RPC', async () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'mode-persist-1-'))
    mkdirSync(join(dir1, 'sessions'), { recursive: true })
    const k = createTestKernel({
      agentDir: dir1,
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    // Set mode to plan via RPC (which triggers writeSessionMeta)
    await k.ctx.rpc.resolve('session.setMode')!({ sessionId: 'main', mode: 'plan' })

    // Verify meta line exists in NDJSON
    const ndjsonPath = join(dir1, 'sessions', 'main.ndjson')
    expect(existsSync(ndjsonPath)).toBe(true)
    const raw = readFileSync(ndjsonPath, 'utf-8')
    expect(raw).toContain('#SESSION_META')
    expect(raw).toContain('"mode":"plan"')

    await k.stop()
    rmSync(dir1, { recursive: true, force: true })
  })

  it('restoreFromDisk reads mode from meta line', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'mode-persist-2-'))
    mkdirSync(join(dir2, 'sessions'), { recursive: true })
    // Pre-populate NDJSON with meta line
    const meta = JSON.stringify({ mode: 'plan' })
    writeFileSync(join(dir2, 'sessions', 'restore-test.ndjson'), `#SESSION_META ${meta}\n`)

    const k = createTestKernel({
      agentDir: dir2,
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    // Mode should be restored from meta
    const mode = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'restore-test' }) as { mode: string }
    expect(mode.mode).toBe('plan')

    await k.stop()
    rmSync(dir2, { recursive: true, force: true })
  })

  it('restoreFromDisk defaults to normal when no meta line', async () => {
    // Fresh directory with no NDJSON files
    const freshDir = mkdtempSync(join(tmpdir(), 'mode-persist-fresh-'))
    mkdirSync(join(freshDir, 'sessions'), { recursive: true })

    const k = createTestKernel({
      agentDir: freshDir,
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const mode = await k.ctx.rpc.resolve('session.getMode')!({ sessionId: 'main' }) as { mode: string }
    expect(mode.mode).toBe('normal')

    await k.stop()
    rmSync(freshDir, { recursive: true, force: true })
  })
})
