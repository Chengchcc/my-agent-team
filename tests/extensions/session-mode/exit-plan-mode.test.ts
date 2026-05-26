import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import sessionModeExt from '../../../src/extensions/session-mode'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'

describe('exit_plan_mode tool (M2)', () => {
  it('exit_plan_mode tool is registered in catalog', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const tool = catalog.get('exit_plan_mode')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('exit_plan_mode')
    expect(tool!.readonly).toBe(true)
    const mockCtx = { sessionId: 'test-session' } as unknown as import('../../../src/application/ports/tool-context').ToolContext
    expect(tool!.conflictKey?.(mockCtx, {} as unknown)).toBe('mode:session:test-session')

    await k.stop()
  })

  it('exit_plan_mode emits session.planProposed on bus', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const events: unknown[] = []
    k.ctx.bus.on('session.planProposed', (payload) => events.push(payload))

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const tool = catalog.get('exit_plan_mode')!

    const result = await tool.execute(
      { signal: new AbortController().signal, environment: { cwd: '/' }, sink: { emit: () => {}, flush: () => {} }, sessionId: 'main', turnId: 't1' },
      { plan: '## Step 1\nDo something' } as Record<string, unknown>,
    )

    expect(result).toContain('Plan submitted')
    expect(events.length).toBe(1)
    const ev = events[0] as { sessionId: string; planMd: string }
    expect(ev.sessionId).toBe('main')
    expect(ev.planMd).toContain('Step 1')

    await k.stop()
  })

  it('exit_plan_mode parse rejects empty plan', async () => {
    const k = createTestKernel({
      extensions: [traceExt(), sessionExt(), toolCatalogExt(), toolsExt(), permissionExt(), sessionModeExt()],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const tool = catalog.get('exit_plan_mode')!

    expect(() => tool.parse?.({ plan: '' })).toThrow('Plan must not be empty')

    await k.stop()
  })
})
