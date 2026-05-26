import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createKernel } from '../../src/kernel/kernel'
import toolCatalogExt from '../../src/extensions/tool-catalog'
import traceExt from '../../src/extensions/trace'
import skillsExt from '../../src/extensions/skills'
import mcpExt from '../../src/extensions/mcp'
import { McpManager } from '../../src/extensions/mcp/manager'

const rpc = (
  k: ReturnType<typeof createKernel>,
  method: string,
  params?: unknown,
) => {
  const h = k.ctx.rpc.resolve(method)
  if (!h) throw new Error(`RPC method not found: ${method}`)
  return h(params ?? {})
}

describe('MCP extension with real McpManager', () => {
  let kernel: ReturnType<typeof createKernel>

  beforeEach(async () => {
    kernel = createKernel({ agentId: 'mcp-test' })
    kernel.use(toolCatalogExt())
    kernel.use(traceExt())
    kernel.use(skillsExt())
    kernel.use(mcpExt())
    await kernel.start()
  })

  afterEach(async () => {
    await kernel.stop()
  })

  it('provides a real McpManager instance', () => {
    const manager = kernel.ctx.extensions.get('mcp.manager')
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(McpManager)
  })

  it('mcp.list RPC returns empty servers initially', async () => {
    const result = await rpc(kernel, 'mcp.list')
    expect((result as { servers: unknown[] }).servers).toEqual([])
  })

  it('mcp.add RPC validates config shape — requires name and transport', async () => {
    await expect(
      rpc(kernel, 'mcp.add', { config: { name: '' } }),
    ).rejects.toThrow('name and transport')

    await expect(
      rpc(kernel, 'mcp.add', { config: { transport: 'stdio' } }),
    ).rejects.toThrow('name and transport')
  })

  it('mcp.remove RPC validates name is required', async () => {
    await expect(rpc(kernel, 'mcp.remove', {})).rejects.toThrow(
      'name is required',
    )
  })

  it('mcp.reload RPC returns added/removed/updated counts', async () => {
    const result = await rpc(kernel, 'mcp.reload')
    expect(result).toEqual({ added: 0, removed: 0, updated: 0 })
  })

  it('McpManager has real methods (hasServer returns false for unknown server)', () => {
    const manager = kernel.ctx.extensions.get('mcp.manager')
    expect(manager.hasServer('nonexistent')).toBe(false)
    expect(typeof manager.getServerTools).toBe('function')
    expect(typeof manager.getServerPrompts).toBe('function')
    expect(typeof manager.connectServer).toBe('function')
    expect(typeof manager.disconnectServer).toBe('function')
    expect(typeof manager.removeServer).toBe('function')
    expect(typeof manager.shutdown).toBe('function')
    // getConnectionStates returns a Map (empty initially)
    const states = manager.getConnectionStates()
    expect(states).toBeInstanceOf(Map)
    expect(states.size).toBe(0)
  })
})
