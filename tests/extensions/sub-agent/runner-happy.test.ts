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

/** Minimal mock provider extension for tests */
const mockProvider = defineExtension({
  name: 'provider',
  enforce: 'pre',
  apply(ctx) {
    return {
      provide: {
        'provider.llm': () => ({
          stream: async function* () {},
          complete: async () => ({ id: 'mock', content: 'ok', usage: { input: 0, output: 0 }, model: 'mock' }),
          call: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
        }),
      },
    }
  },
})

/** Minimal mock infra-services extension for tests */
const mockInfraServices = defineExtension({
  name: 'infra-services',
  enforce: 'post',
  apply(ctx) {
    return {
      provide: {
        'infra-services.job-spawner': () => ({
          run: async () => ({ finalText: 'mock result', usage: { input: 0, output: 0 }, toolCallCount: 0, rounds: 1 }),
        }),
      },
    }
  },
})

describe('sub-agent runner (M2)', () => {
  it('registers task tool in catalog on start', async () => {
    const k = createTestKernel({
      extensions: [
        mockProvider, mockInfraServices,
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog') as ToolCatalog
    const taskTool = catalog.get('task')
    expect(taskTool).toBeDefined()
    expect(taskTool!.name).toBe('task')
    expect(typeof taskTool!.execute).toBe('function')

    await k.stop()
  })

  it('sub-agent registry exposes explore, plan, general-purpose builtins', async () => {
    const k = createTestKernel({
      extensions: [
        mockProvider, mockInfraServices,
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const registry = k.ctx.extensions.get('sub-agent.registry')
    expect(registry).toBeDefined()
    expect(registry.get('explore')).toBeDefined()
    expect(registry.get('plan')).toBeDefined()
    expect(registry.get('general-purpose')).toBeDefined()

    await k.stop()
  })

  it('task tool with unknown type returns structured error', async () => {
    const k = createTestKernel({
      extensions: [
        mockProvider, mockInfraServices,
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog') as ToolCatalog
    const taskTool = catalog.get('task')!

    const result = await taskTool.execute(
      {
        signal: new AbortController().signal,
        environment: { cwd: '/tmp' },
        sink: { emit: () => {}, flush: () => {} },
        sessionId: 's1',
        turnId: 't1',
        callId: 'c1',
      },
      { subagent_type: 'nonexistent', description: 'test', prompt: 'do something' },
    ) as string

    expect(result).toContain('<sub-agent-error')
    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')

    await k.stop()
  })
})
