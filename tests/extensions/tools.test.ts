import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import toolCatalogExt from '../../src/extensions/tool-catalog'
import toolsExt from '../../src/extensions/tools'
import type { ToolCatalog } from '../../src/application/ports/tool-catalog'

describe('tools extension', () => {
  it('should register 9 builtin tools in the catalog', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt(), toolsExt()] })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    expect(catalog).toBeDefined()

    const tools = catalog.list()
    expect(tools.length).toBeGreaterThanOrEqual(9)

    const readTool = catalog.get('read')
    expect(readTool).toBeDefined()
    expect(readTool!.name).toBe('read')
    expect(readTool!.description).toContain('Read')

    await k.stop()
  })

  it('should execute tool and return result via onToolCall hook', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt(), toolsExt()] })
    await k.start()

    const result = (await k.ctx.hooks.dispatch('onToolCall', {
      name: 'read',
      arguments: { path: 'package.json' },
      id: 'call-1',
    }, { signal: new AbortController().signal, environment: { cwd: process.cwd() } })) as { content: string; isError?: boolean }

    expect(result).toBeDefined()
    expect(typeof result.content).toBe('string')
    expect(result.content.length).toBeGreaterThan(0)

    await k.stop()
  })

  it('should emit tool.executed bus event on tool call', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt(), toolsExt()] })
    await k.start()

    let busEvent: unknown = null
    k.ctx.bus.on('tool.executed', (payload) => {
      busEvent = payload
    })

    await k.ctx.hooks.dispatch('onToolCall', {
      name: 'bash',
      arguments: { command: 'echo hello' },
      id: 'call-2',
    }, { signal: new AbortController().signal, environment: { cwd: process.cwd() } })

    expect(busEvent).not.toBeNull()
    const env = busEvent as { payload: { name: string; duration: number; isError: boolean } }
    expect(env.payload.name).toBe('bash')
    expect(typeof env.payload.duration).toBe('number')
    expect(env.payload.isError).toBe(false)

    await k.stop()
  })

  it('should return error result for unknown tool', async () => {
    const k = createTestKernel({ extensions: [toolCatalogExt(), toolsExt()] })
    await k.start()

    const result = (await k.ctx.hooks.dispatch('onToolCall', {
      name: 'nonexistent',
      arguments: {},
      id: 'call-3',
    }, { signal: new AbortController().signal, environment: { cwd: process.cwd() } })) as { content: string; isError?: boolean }

    expect(result).toBeDefined()
    expect(result.isError).toBe(true)
    expect(result.content).toBe('Tool not found: nonexistent')

    await k.stop()
  })
})
