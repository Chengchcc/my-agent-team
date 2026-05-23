import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function tmpProfileDir(): string {
  const dir = join(tmpdir(), `test-session-replace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('session history replace', () => {
  it('replace overwrites in-memory map with new array', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-replace1',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      get(sid: string): unknown[]
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
      replace(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    // First append some messages
    await history.appendBatch('main', [
      { role: 'user', content: 'msg1', id: 'a1' },
      { role: 'assistant', content: 'msg2', id: 'a2' },
    ])
    expect(history.get('main')).toHaveLength(2)

    // Replace with new messages
    await history.replace('main', [
      { role: 'user', content: 'replaced', id: 'r1' },
    ])
    const msgs = history.get('main')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'replaced', id: 'r1' })

    await k.stop()
  })

  it('replace writes NDJSON file with rewritten content', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-replace2',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
      replace(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    // Setup initial data
    await history.appendBatch('main', [
      { role: 'user', content: 'original', id: 'o1' },
    ])

    // Replace
    await history.replace('main', [
      { role: 'user', content: 'rewritten', id: 'r1' },
      { role: 'assistant', content: 'rewritten2', id: 'r2' },
    ])

    const ndjsonPath = join(agentDir, 'sessions', 'main.ndjson')
    expect(existsSync(ndjsonPath)).toBe(true)

    const raw = readFileSync(ndjsonPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ role: 'user', content: 'rewritten' })
    expect(JSON.parse(lines[1])).toMatchObject({ role: 'assistant', content: 'rewritten2' })

    await k.stop()
  })

  it('replace with empty array clears in-memory and leaves empty NDJSON', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-replace3',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      get(sid: string): unknown[]
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
      replace(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    await history.appendBatch('main', [
      { role: 'user', content: 'to-be-cleared', id: 'c1' },
    ])
    expect(history.get('main')).toHaveLength(1)

    await history.replace('main', [])
    expect(history.get('main')).toHaveLength(0)

    const ndjsonPath = join(agentDir, 'sessions', 'main.ndjson')
    expect(existsSync(ndjsonPath)).toBe(true)
    const raw = readFileSync(ndjsonPath, 'utf-8')
    expect(raw).toBe('')

    await k.stop()
  })

  it('replace isolates sessions — does not affect other session', async () => {
    const agentDir = tmpProfileDir()
    const k = createTestKernel({
      agentId: 'test-replace4',
      agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const history = k.ctx.extensions.get<{
      get(sid: string): unknown[]
      appendBatch(sid: string, msgs: unknown[]): Promise<void>
      replace(sid: string, msgs: unknown[]): Promise<void>
    }>('session.history')

    await history.appendBatch('main', [{ role: 'user', content: 'main-keep', id: 'mk1' }])
    await history.appendBatch('other', [{ role: 'user', content: 'other-keep', id: 'ok1' }])

    await history.replace('main', [{ role: 'assistant', content: 'main-replaced', id: 'mr1' }])

    // Main replaced
    expect(history.get('main')).toHaveLength(1)
    expect(history.get('main')[0]).toMatchObject({ content: 'main-replaced' })

    // Other unchanged
    expect(history.get('other')).toHaveLength(1)
    expect(history.get('other')[0]).toMatchObject({ content: 'other-keep' })

    await k.stop()
  })
})
