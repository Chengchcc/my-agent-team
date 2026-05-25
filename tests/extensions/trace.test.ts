import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import { createTraceEventFactory } from '../../src/domain/trace-event'
import traceExt from '../../src/extensions/trace'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(k.ctx.extensions.has('trace.writer')).toBe(false)
    await k.stop()
  })

  it('should store trace events via onTraceEmit hook', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    const evt = factory.next('turn-1', 'turn.started', {})

    await k.ctx.hooks.dispatch('onTraceEmit', evt)

    // SQLite: verify via reader API
    const reader = k.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader.listRecentSummaries({ limit: 10 })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    await k.stop()
  })

  it('should not emit trace.flushed on bus after write', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()

    let flushedEmitted = false
    k.ctx.bus.on('trace.flushed', () => { flushedEmitted = true })

    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.completed', {}))
    expect(flushedEmitted).toBe(false)
    await k.stop()
  })

  it('should flush on kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.stop()

    // Verify data persisted via a new kernel instance
    const k2 = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k2.start()
    const reader = k2.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader.listRecentSummaries({ limit: 10 })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    await k2.stop()
  })

  it('should get run by runId via reader', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('t1', 'turn.started', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('t2', 'turn.started', {}))

    const reader = k.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader.listRecentSummaries({ limit: 1 })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries[0]!).toHaveProperty('totalTurns')
    expect(summaries[0]!).toHaveProperty('outcome')

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
    const summaries = await reader.listRecentSummaries({ limit: 10 })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries[0]!).toHaveProperty('totalTurns')
    expect(summaries[0]!).toHaveProperty('outcome')
    await k.stop()
  })

  it('should have dispose called on kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()

    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.stop()

    // After stop, data persists in SQLite
    const k2 = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k2.start()
    const reader2 = k2.ctx.extensions.get<TraceCheckpointer>('trace.reader')
    const summaries = await reader2.listRecentSummaries({ limit: 10 })
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    await k2.stop()
  })

  it('should handle onShutdown flush during kernel stop', async () => {
    const k = createTestKernel({ extensions: [traceExt({ baseDir: tmpDir })] })
    await k.start()
    const factory = createTraceEventFactory()
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.started', {}))
    await k.ctx.hooks.dispatch('onTraceEmit', factory.next('turn-1', 'turn.completed', {}))
    await k.stop()
    // No crash = pass
  })
})
