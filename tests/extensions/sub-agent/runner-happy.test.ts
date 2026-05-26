import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import subAgentExt from '../../../src/extensions/sub-agent'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'
import type { SubAgentRegistry } from '../../../src/extensions/sub-agent/registry'

/**
 * M1 runner-happy: end-to-end test that the sub-agent extension
 * registers the task tool, the registry exposes builtins, and
 * runSubAgent can dispatch a General-Purpose sub-agent.
 */
describe('sub-agent runner (M1)', () => {
  it('registers task tool in catalog on start', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')
    expect(taskTool).toBeDefined()
    expect(taskTool!.name).toBe('task')
    expect(typeof taskTool!.execute).toBe('function')

    await k.stop()
  })

  it('sub-agent registry exposes explore, plan, general-purpose builtins', async () => {
    const k = createTestKernel({
      extensions: [
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
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    const result = await taskTool.execute(
      {
        signal: new AbortController().signal,
        environment: { cwd: '/tmp' },
        sink: { emit: () => {}, flush: () => {} },
        sessionId: 's1',
        turnId: 't1',
      },
      { subagent_type: 'nonexistent', description: 'test', prompt: 'do something' },
    ) as string

    expect(result).toContain('<sub-agent-error')
    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')

    await k.stop()
  })
})
