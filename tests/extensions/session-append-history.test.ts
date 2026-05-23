import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function tmpProfileDir(): string {
  const dir = join(tmpdir(), `test-session-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('session history capability', () => {
  it('exposes history.get as alias for messages.get', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-hist',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{ get(sid: string): unknown[] }>('session.history')
    const msgs = history.get('main')
    expect(Array.isArray(msgs)).toBe(true)

    await k.stop()
  })

  it('history.get and messages.get return same array reference', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-hist2',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{ get(sid: string): unknown[] }>('session.history')
    const messages = k.ctx.extensions.get<{ get(sid: string): unknown[] }>('session.messages')

    const hMsgs = history.get('main')
    const mMsgs = messages.get('main')
    // Same reference — they share the underlying Map
    expect(hMsgs).toBe(mMsgs)

    await k.stop()
  })

  it('appendBatch pushes to in-memory array', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-hist3',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      get(sid: string): unknown[]
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    await history.appendBatch('main', [
      { role: 'user', content: 'hello', id: '1' },
      { role: 'assistant', content: 'hi', id: '2' },
    ])

    const msgs = history.get('main')
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' })

    await k.stop()
  })

  it('appendBatch writes NDJSON to agentDir/sessions/<sid>.ndjson', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-hist4',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    const msgs = [
      { role: 'user', content: 'test', id: 'ndjson-1' },
    ]
    await history.appendBatch('main', msgs)

    // Verify NDJSON file exists and contains the message
    const ndjsonPath = join(agentDir, 'sessions', 'main.ndjson')
    expect(existsSync(ndjsonPath)).toBe(true)

    const raw = readFileSync(ndjsonPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed).toMatchObject({ role: 'user', content: 'test' })

    await k.stop()
  })

  it('appendBatch isolates sessions to separate NDJSON files', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-hist5',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    await history.appendBatch('main', [{ role: 'user', content: 'main-msg', id: 'm1' }])
    await history.appendBatch('other', [{ role: 'user', content: 'other-msg', id: 'o1' }])

    const mainRaw = readFileSync(join(agentDir, 'sessions', 'main.ndjson'), 'utf-8')
    const otherRaw = readFileSync(join(agentDir, 'sessions', 'other.ndjson'), 'utf-8')

    expect(JSON.parse(mainRaw.trim())).toMatchObject({ content: 'main-msg' })
    expect(JSON.parse(otherRaw.trim())).toMatchObject({ content: 'other-msg' })

    await k.stop()
  })
})
