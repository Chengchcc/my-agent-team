import { describe, it, expect } from 'bun:test'
import { RpcRegistry } from '../../src/kernel/rpc-registry'

describe('RpcRegistry', () => {
  it('registers a handler and resolves by method name', () => {
    const reg = new RpcRegistry()
    const handler = async (params: unknown) => ({ ok: true, params })
    reg.register('test.method', handler)
    expect(reg.resolve('test.method')).toBe(handler)
  })

  it('resolve returns undefined for unknown method', () => {
    const reg = new RpcRegistry()
    expect(reg.resolve('nope')).toBeUndefined()
  })

  it('register throws on duplicate method name', () => {
    const reg = new RpcRegistry()
    reg.register('test.method', async () => 'a', 'ext-a')
    expect(() => reg.register('test.method', async () => 'b', 'ext-b'))
      .toThrow('RPC method "test.method" already registered by "ext-a" (conflict with "ext-b")')
  })

  it('has returns true for registered method', () => {
    const reg = new RpcRegistry()
    reg.register('test.method', async () => {})
    expect(reg.has('test.method')).toBe(true)
    expect(reg.has('nope')).toBe(false)
  })

  it('listMethods returns all registered names', () => {
    const reg = new RpcRegistry()
    reg.register('a', async () => {})
    reg.register('b', async () => {})
    expect(reg.listMethods().sort()).toEqual(['a', 'b'])
  })

  it('unregister removes a method and returns true', () => {
    const reg = new RpcRegistry()
    reg.register('test.method', async () => {})
    expect(reg.unregister('test.method')).toBe(true)
    expect(reg.has('test.method')).toBe(false)
  })

  it('unregister returns false for unknown method', () => {
    const reg = new RpcRegistry()
    expect(reg.unregister('nope')).toBe(false)
  })

  it('clear removes all registered methods', () => {
    const reg = new RpcRegistry()
    reg.register('a', async () => {})
    reg.register('b', async () => {})
    reg.clear()
    expect(reg.listMethods()).toHaveLength(0)
  })

  it('unregisterByExtension removes all methods for an extension', () => {
    const reg = new RpcRegistry()
    reg.register('ext-a.method1', async () => {}, 'ext-a')
    reg.register('ext-a.method2', async () => {}, 'ext-a')
    reg.register('ext-b.other', async () => {}, 'ext-b')
    reg.unregisterByExtension('ext-a')
    expect(reg.has('ext-a.method1')).toBe(false)
    expect(reg.has('ext-a.method2')).toBe(false)
    expect(reg.has('ext-b.other')).toBe(true)
  })
})
