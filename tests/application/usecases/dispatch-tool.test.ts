import { describe, it, expect } from 'bun:test'
import { dispatchTool } from '../../../src/application/usecases/dispatch-tool'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'
import type { ToolExecutor } from '../../../src/application/ports/tool-executor'
import type { ToolContext } from '../../../src/application/ports/tool-context'
import type { Tool } from '../../../src/application/ports/tool'

function makeCtx(): ToolContext {
  return {} as ToolContext
}

function makeCatalog(tools: Tool[] = []): ToolCatalog {
  const map = new Map(tools.map(t => [t.name, t]))
  return {
    get: (name: string) => map.get(name),
    list: () => [...map.values()],
    register: (t: Tool) => { map.set(t.name, t) },
    has: (name: string) => map.has(name),
  }
}

function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    execute: async (_ctx: ToolContext, _input: Record<string, unknown>) => `result:${name}`,
    ...overrides,
  }
}

describe('dispatchTool', () => {
  it('returns error when tool not found', async () => {
    const catalog = makeCatalog()
    const executor = { execute: async () => 'unreachable' }
    const result = await dispatchTool(catalog, executor, { name: 'nope', arguments: {} }, makeCtx())
    expect(result).toEqual({ content: 'Tool not found: nope', isError: true })
  })

  it('dispatches to executor when tool found', async () => {
    const tool = makeTool('read')
    const catalog = makeCatalog([tool])
    const executor: ToolExecutor = {
      execute: async (_t, input, _ctx) => ({ content: `read: ${JSON.stringify(input)}` }),
    }
    const result = await dispatchTool(catalog, executor, { name: 'read', arguments: { path: '/a' } }, makeCtx())
    expect(result).toEqual({ content: 'read: {"path":"/a"}' })
  })

  it('uses tool.parse when defined to transform arguments', async () => {
    const tool = makeTool('write', {
      parse: (args: Record<string, unknown>) => ({ ...args, parsed: true }),
    })
    const catalog = makeCatalog([tool])
    let received: Record<string, unknown> | undefined
    const executor: ToolExecutor = {
      execute: async (_t, input, _ctx) => { received = input as Record<string, unknown>; return 'ok' },
    }
    await dispatchTool(catalog, executor, { name: 'write', arguments: { path: '/f' } }, makeCtx())
    expect(received).toEqual({ path: '/f', parsed: true })
  })

  it('passes raw arguments when tool has no parse', async () => {
    const tool = makeTool('read')
    const catalog = makeCatalog([tool])
    let received: Record<string, unknown> | undefined
    const executor: ToolExecutor = {
      execute: async (_t, input, _ctx) => { received = input as Record<string, unknown>; return 'ok' },
    }
    await dispatchTool(catalog, executor, { name: 'read', arguments: { path: '/f' } }, makeCtx())
    expect(received).toEqual({ path: '/f' })
  })
})
