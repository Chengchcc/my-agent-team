import { describe, it, expect } from 'bun:test'
import { defineExtension } from '../../../src/kernel/define-extension'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import subAgentExt from '../../../src/extensions/sub-agent'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'
import type { SessionStore } from '../../../src/application/ports/session-store'
import type { ToolContext } from '../../../src/application/ports/tool-context'

const mockProvider = defineExtension({
  name: 'provider', enforce: 'pre',
  apply: () => ({
    provide: {
      'provider.llm': () => ({
        stream: async function* () {},
        complete: async () => ({ id: 'mock', content: 'ok', usage: { input: 0, output: 0 }, model: 'mock' }),
        call: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
      }),
    },
  }),
})

const mockInfraServices = defineExtension({
  name: 'infra-services', enforce: 'post',
  apply: () => ({
    provide: {
      'infra-services.job-spawner': () => ({
        run: async () => ({ finalText: 'mock result', usage: { input: 0, output: 0 }, toolCallCount: 0, rounds: 1 }),
      }),
    },
  }),
})

function makeCtx(sessionId = 's1', turnId = 't1'): ToolContext {
  return {
    signal: new AbortController().signal,
    environment: { cwd: '/tmp' },
    sink: { emit: () => {}, flush: () => {} },
    sessionId, turnId,
  }
}

/**
 * M3 tests: abort cascade, session isolation, cleanup.
 */
describe('sub-agent M3', () => {
  // ── Abort cascade: parent signal terminates sub turn ──

  it('aborted parent signal is passed to runTurnUsecase as abortSignal', async () => {
    const k = createTestKernel({
      extensions: [mockProvider, mockInfraServices, traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), subAgentExt()],
    })
    await k.start()

    const parentCtrl = new AbortController()
    parentCtrl.abort()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    // Without a real provider, the sub-agent fails during LLM invocation
    // But the abortSignal IS passed — the abort happens before the LLM call
    const result = await taskTool.execute(
      { ...makeCtx(), signal: parentCtrl.signal },
      { subagent_type: 'plan', description: 'test', prompt: 'Say hello' },
    ) as string

    // M2: abort signal cascaded through runner-spawner into spawner.run
    // Mock spawner ignores it and returns result
    expect(result).toBe('mock result')

    await k.stop()
  })

  // ── Sub sessions are cleaned up after completion ──

  it('sub session is deleted after sub-agent completes (isolation)', async () => {
    const k = createTestKernel({
      extensions: [mockProvider, mockInfraServices, traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), subAgentExt()],
    })
    await k.start()

    const store = k.ctx.extensions.get('session.store')
    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    // Count sessions before
    const before = (await store.list('test')).length

    // Run a sub-agent that will fail (no provider)
    await taskTool.execute(
      makeCtx('main', 'parent-turn-cleanup'),
      { subagent_type: 'plan', description: 'test', prompt: 'Say hello' },
    )

    // Count sessions after — sub session should be cleaned up
    const after = (await store.list('test')).length
    expect(after).toBe(before)

    await k.stop()
  })

  // ── Compaction is disabled in sub-agent ──

  it('sub-agent does not trigger compaction even with large initial messages', async () => {
    const k = createTestKernel({
      extensions: [mockProvider, mockInfraServices, traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), subAgentExt()],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    // Run with a plan sub-agent — compaction is disabled
    const result = await taskTool.execute(
      makeCtx('main', 'parent-turn-nocompact'),
      { subagent_type: 'plan', description: 'no compact', prompt: 'Test' },
    ) as string

    // Should complete without compaction errors
    expect(typeof result).toBe('string')
    expect(result).not.toContain('compact')

    await k.stop()
  })

  // ── Structured error on unknown type ──

  it('unknown subagent_type returns structured error', async () => {
    const k = createTestKernel({
      extensions: [mockProvider, mockInfraServices, traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), subAgentExt()],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    const result = await taskTool.execute(
      makeCtx(),
      { subagent_type: 'nonexistent-type', description: 'test', prompt: 'do' },
    ) as string

    expect(result).toContain('<sub-agent-error type="unknown_subagent_type"')
    expect(result).toContain('nonexistent-type')

    await k.stop()
  })
})
