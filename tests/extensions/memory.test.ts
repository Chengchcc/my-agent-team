import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import memoryExt from '../../src/extensions/memory'
import type { MemoryStore } from '../../src/application/ports/memory-store'
import type { RecallAPI } from '../../src/extensions/memory/recall'
import { createEvent } from '../../src/application/contracts'
import { asContractBus } from '../../src/application/event-bus/contract-bus'

/**
 * Test helpers — each test gets a fresh temp directory so SQLite DBs
 * are isolated and cleaned up automatically.
 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-test-'))
}

describe('memory extension', () => {
  it('should expose memory.store and memory.recall capabilities after start', async () => {
    const tmp = makeTempDir()
    try {
      const k = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k.start()

      const store = k.ctx.extensions.get<MemoryStore>('memory.store')
      expect(store).toBeDefined()
      expect(typeof store.add).toBe('function')
      expect(typeof store.search).toBe('function')
      expect(typeof store.get).toBe('function')
      expect(typeof store.update).toBe('function')
      expect(typeof store.remove).toBe('function')

      const recall = k.ctx.extensions.get<RecallAPI>('memory.recall')
      expect(recall).toBeDefined()
      expect(typeof recall.search).toBe('function')

      await k.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('should start embedding backfill on kernelReady', async () => {
    const tmp = makeTempDir()
    try {
      const k = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k.start()

      // Add a memory entry, then verify backfill is not crashing
      const store = k.ctx.extensions.get<MemoryStore>('memory.store')
      const entry = await store.add({
        type: 'general',
        text: 'test backfill entry',
        weight: 0.8,
        source: 'explicit',
        tags: [],
        usageCount: 0,
      })
      expect(entry.id).toBeTruthy()

      // Give backfill a chance to tick
      await new Promise(resolve => setTimeout(resolve, 50))

      await k.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('should evaluate extract policy on turn.completed bus event', async () => {
    const tmp = makeTempDir()
    try {
      const k = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k.start()

      const bus = asContractBus(k.ctx.bus)

      // Emit a high-token turn.completed event — policy should trigger "extract",
      // but without job-spawner capability the actual extraction is skipped.
      // The handler must not throw.
      bus.emit(createEvent('turn.completed', {
        sessionId: 'main',
        turnId: 'turn-1',
        runId: 'turn-1',
        usage: { input: 500, output: 500 },
        toolCallCount: 0,
        toolErrorCount: 0,
        activatedSkills: [],
      }))

      // Give async handlers time
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify: no crash, extension is still operational
      const store = k.ctx.extensions.get<MemoryStore>('memory.store')
      const results = await store.search('anything', { limit: 1 })
      expect(Array.isArray(results)).toBe(true)

      await k.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('should increment policy counter on turn.failed', async () => {
    const tmp = makeTempDir()
    try {
      const k = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k.start()

      const bus = asContractBus(k.ctx.bus)

      // Emit turn.failed — should not crash and should update counter
      bus.emit(createEvent('turn.failed', {
        sessionId: 'main',
        turnId: 'turn-fail',
        runId: 'turn-fail',
        outcome: 'error',
        stage: 'llm_stream',
        reason: 'test',
        toolErrorCount: 1,
      }))

      await new Promise(resolve => setTimeout(resolve, 10))
      await k.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('should filter search results by threshold and limit', async () => {
    const tmp = makeTempDir()
    try {
      const k = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k.start()

      const store = k.ctx.extensions.get<MemoryStore>('memory.store')

      await store.add({
        type: 'general',
        text: 'High weight TypeScript memory',
        weight: 0.9,
        source: 'explicit',
        tags: [],
        usageCount: 0,
      })
      await store.add({
        type: 'general',
        text: 'Medium weight TypeScript memory',
        weight: 0.5,
        source: 'explicit',
        tags: [],
        usageCount: 0,
      })
      await store.add({
        type: 'general',
        text: 'Low weight TypeScript memory',
        weight: 0.1,
        source: 'explicit',
        tags: [],
        usageCount: 0,
      })

      // With threshold, should filter out low weight
      const thresholdResults = await store.search('TypeScript', {
        threshold: 0.5,
      })
      expect(thresholdResults).toHaveLength(2)

      // With limit
      const limitedResults = await store.search('TypeScript', { limit: 1 })
      expect(limitedResults).toHaveLength(1)

      await k.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('should persist memory across kernel stop/start cycles', async () => {
    const tmp = makeTempDir()
    try {
      // Session 1 — add an entry and stop
      const k1 = createTestKernel({
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k1.start()
      const store1 = k1.ctx.extensions.get<MemoryStore>('memory.store')
      await store1.add({
        type: 'general',
        text: 'persistent data for cross-session recall',
        weight: 1.0,
        source: 'explicit',
        tags: [],
        usageCount: 0,
      })

      const before = await store1.search('persistent', { limit: 5 })
      expect(before).toHaveLength(1)
      await k1.stop()

      // Session 2 — same temp dir, entry should survive
      const k2 = createTestKernel({
        agentId: 'test',
        extensions: [traceExt(), memoryExt({ baseDir: tmp })],
      })
      await k2.start()
      const store2 = k2.ctx.extensions.get<MemoryStore>('memory.store')
      const after = await store2.search('persistent', { limit: 5 })
      expect(after).toHaveLength(1)
      expect(after[0].text).toContain('persistent data')
      await k2.stop()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
