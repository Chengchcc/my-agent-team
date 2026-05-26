import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'

describe('tools extension transformPrompt', () => {
  it('appends TODO_WRITE_GUIDANCE when todo_write registered', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt(), toolsExt()] })
    await k.start()

    // verify todo_write is registered
    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    expect(catalog.get('todo_write')).toBeDefined()

    // dispatch transformPrompt
    const result = await k.ctx.hooks.dispatch('transformPrompt', {
      system: 'base system prompt',
      messages: [{ role: 'user', content: 'hello' }],
    }) as { system: string; messages: Array<{ role: string; content: string }> }

    expect(result.system).toContain('base system prompt')
    expect(result.system).toContain('Task Tracking')
    expect(result.system).toContain('todo_write')
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])

    await k.stop()
  })

  it('does NOT append when todo_write absent from catalog', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt()] })
    await k.start()

    const result = await k.ctx.hooks.dispatch('transformPrompt', {
      system: 'base system prompt',
      messages: [],
    }) as { system: string }

    // transformPrompt hook only fires if registered; since tools ext isn't loaded,
    // no transformPrompt handler exists. The hook dispatches and returns the
    // input unchanged when no handlers are registered.
    expect(result.system).toBe('base system prompt')

    await k.stop()
  })
})
