import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import { createTraceEventFactory } from '../../src/domain/trace-event'
import traceExt from '../../src/extensions/trace'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import type { TraceCheckpointer } from '../../src/application/ports/trace-checkpointer'

describe('trace extension', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trace-test-'))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('should register with correct name and enforce', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const ext = k.ctx.extensions.getExtension('trace')
    expect(ext?.name).toBe('trace')
    expect(ext?.builder.enforce).toBe('pre')
    await k.stop()
  })

  it('should expose trace.reader capability', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const reader = k.ctx.extensions.get('trace.reader')
    expect(reader).toBeDefined()
    // No longer exposes trace.writer — only trace.reader
    expect(k.ctx.extensions.has('trace.writer')).toBe(false)
    await k.stop()
  })

  it('should store trace events via onTraceEmit hook', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    const evt = factory.next('turn-1', 'turn.started', {})

    // Dispatch onTraceEmit hook → checkpointer.append(event)
    await k.ctx.hooks.dispatch('onTraceEmit', evt)

    // Find the latest trace file and verify the event was persisted
    const sessionDir = join(tmpDir, 'test')
    const entries = readdirSync(sessionDir)
    const runFiles = entries.filter(f => f.endsWith('.jsonl')).sort()
    expect(runFiles.length).toBeGreaterThanOrEqual(1)
    const latestFile = runFiles[runFiles.length - 1]
    const content = readFileSync(join(sessionDir, latestFile), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const stored = JSON.parse(lines[0])
    expect(stored.type).toBe('turn.started')
    await k.stop()
  })

  it('should not emit trace.flushed on bus after write', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()

    let flushedEmitted = false
    k.ctx.bus.on('trace.flushed', () => {
      flushedEmitted = true
    })

    const factory = createTraceEventFactory()
    const evt = factory.next('turn-1', 'turn.completed', {})
    await k.ctx.hooks.dispatch('onTraceEmit', evt)

    // onTraceEmit no longer emits trace.flushed on the bus
    expect(flushedEmitted).toBe(false)
    await k.stop()
  })

  it('should flush on kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.stop()

    // flush() is a no-op for NdjsonCheckpointer, so events persist on disk.
    // (Old behavior called clear() which deleted the trace file; new behavior preserves it.)
    const sessionDir = join(tmpDir, 'test')
    const entries = readdirSync(sessionDir)
    const runFiles = entries.filter(f => f.endsWith('.jsonl'))
    expect(runFiles.length).toBeGreaterThanOrEqual(1)
    const content = readFileSync(join(sessionDir, runFiles[runFiles.length - 1]), 'utf-8')
    expect(content.trim()).not.toBe('')
  })

  it('should get run by runId', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('t1', 'turn.started', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('t2', 'turn.started', {}))

    const reader = k.ctx.extensions.get<TraceCheckpointer>('trace.reader')

    // Find the runId from the filesystem
    const sessionDir = join(tmpDir, 'test')
    const entries = readdirSync(sessionDir)
    const runFiles = entries.filter(f => f.endsWith('.jsonl')).sort()
    const runId = runFiles[runFiles.length - 1].replace('.jsonl', '')

    const run = await reader.getRun(runId)
    expect(run).not.toBeNull()
    expect(run!.id).toBe(runId)

    // Nonexistent runId returns null
    const missing = await reader.getRun('nonexistent-run')
    expect(missing).toBeNull()

    await k.stop()
  })

  it('should list recent summaries', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'tool.call', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.completed', {}))

    const reader = k.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader.listRecentSummaries({ limit: 10, sessionId: 'test' })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    // Each summary has the expected shape
    expect(summaries[0]).toHaveProperty('totalTurns')
    expect(summaries[0]).toHaveProperty('outcome')

    await k.stop()
  })

  it('should have dispose called on kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()

    // Store events
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))

    // Verify events exist before stop
    const sessionDir = join(tmpDir, 'test')
    const entries = readdirSync(sessionDir)
    const runFiles = entries.filter(f => f.endsWith('.jsonl')).sort()
    expect(runFiles.length).toBeGreaterThanOrEqual(1)

    await k.stop()

    // After stop, dispose calls flush (not clear), so data persists.
    // A new kernel can still see the old run data via listRecentSummaries.
    const k2 = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k2.start()
    const reader2 = k2.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader2.listRecentSummaries({ limit: 10, sessionId: 'test' })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    await k2.stop()
  })

  it('should handle onShutdown flush during kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()

    // Write some events
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.completed', {}))

    // Stop should trigger onShutdown hook -> flush, then dispose
    await k.stop()

    // No crash = pass. Flush is a noop for fs checkpointer but it was called.
  })
})
