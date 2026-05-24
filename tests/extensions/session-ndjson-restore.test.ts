import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * DESIGN.md gap #10: Session NDJSON corruption tolerance on restoreFromDisk.
 *
 * The session extension calls restoreFromDisk on kernelReady.
 * It reads <agentDir>/sessions/*.ndjson — each line is a JSON HistoryRecord.
 * Corrupted files are caught and skipped.
 */

describe('session NDJSON restoreFromDisk', () => {
  let agentDir: string

  beforeAll(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'session-ndjson-'))
    const sessionsDir = join(agentDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })

    // Valid NDJSON: session "good" with 2 messages
    const validLine1 = JSON.stringify({
      kind: 'history.record', version: 1, sessionId: 'good',
      role: 'user', content: 'hello', ts: 1000,
    })
    const validLine2 = JSON.stringify({
      kind: 'history.record', version: 1, sessionId: 'good',
      role: 'assistant', content: 'hi there', ts: 1001,
    })
    writeFileSync(join(sessionsDir, 'good.ndjson'), `${validLine1}\n${validLine2}\n`)

    // Corrupted NDJSON: session "bad" with invalid JSON
    writeFileSync(join(sessionsDir, 'bad.ndjson'), 'this is not json at all\n{also bad\n')

    // Empty NDJSON: session "empty" with only whitespace
    writeFileSync(join(sessionsDir, 'empty.ndjson'), '\n\n')
  })

  afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('restores valid sessions and skips corrupted NDJSON files', async () => {
    const k = createTestKernel({
      agentId: 'test-agent',
      agentDir: agentDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    // "good" session should be restored
    const store = k.ctx.extensions.get<{ load: (id: string) => Promise<unknown> }>('session.store')
    const goodSession = await store.load('good')
    expect(goodSession).not.toBeNull()

    const history = k.ctx.extensions.get<{ get: (sid: string) => unknown[] }>('session.history')

    // History for "good" should have the 2 messages
    const msgs = history.get('good')
    expect(msgs).toHaveLength(2)

    // "bad" session exists but with empty history (corrupted lines skipped by parseHistoryLine)
    const badSession = await store.load('bad')
    expect(badSession).not.toBeNull()
    const badMsgs = history.get('bad')
    expect(badMsgs).toHaveLength(0)

    await k.stop()
  })

  it('handles non-existent sessions directory gracefully', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'session-fresh-'))
    // Don't create sessions/ subdirectory — restoreFromDisk handles ENOENT

    const k = createTestKernel({
      agentId: 'test-agent',
      agentDir: freshDir,
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const store = k.ctx.extensions.get<{ list: (agentId: string) => Promise<unknown[]> }>('session.store')
    const sessions = (await store.list('test-agent')) as Array<{ id: string }>
    // Main session should still be created
    expect(sessions.length).toBe(1)
    expect(sessions[0]!.id).toBe('main')

    await k.stop()
    rmSync(freshDir, { recursive: true, force: true })
  })
})
