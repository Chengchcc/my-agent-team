import { describe, it, expect } from 'bun:test'
import { defineExtension } from '../../src/kernel/define-extension'

describe('defineExtension', () => {
  it('returns a frozen object with correct defaults', () => {
    const apply = () => ({})
    const ext = defineExtension({
      name: 'test',
      apply,
    })

    expect(ext.name).toBe('test')
    expect(ext.enforce).toBe('normal')
    expect(ext.dependsOn).toEqual([])
    expect(Object.isFrozen(ext)).toBe(true)
  })

  it('enforce defaults to normal', () => {
    const ext = defineExtension({
      name: 'test',
      apply: () => ({}),
    })

    expect(ext.enforce).toBe('normal')
  })

  it('dependsOn defaults to empty frozen array', () => {
    const ext = defineExtension({
      name: 'test',
      apply: () => ({}),
    })

    expect(ext.dependsOn).toEqual([])
    expect(Object.isFrozen(ext.dependsOn)).toBe(true)
  })

  it('can override enforce to pre', () => {
    const ext = defineExtension({
      name: 'test',
      enforce: 'pre',
      apply: () => ({}),
    })

    expect(ext.enforce).toBe('pre')
  })

  it('can override enforce to post', () => {
    const ext = defineExtension({
      name: 'test',
      enforce: 'post',
      apply: () => ({}),
    })

    expect(ext.enforce).toBe('post')
  })

  it('apply function is preserved', () => {
    const apply = () => ({ provide: { foo: () => 'bar' } })
    const ext = defineExtension({
      name: 'test',
      apply,
    })

    expect(ext.apply).toBe(apply)
  })

  it('dependsOn array is frozen when explicitly provided', () => {
    const ext = defineExtension({
      name: 'test',
      dependsOn: ['trace', 'memory'],
      apply: () => ({}),
    })

    expect(ext.dependsOn).toEqual(['trace', 'memory'])
    expect(Object.isFrozen(ext.dependsOn)).toBe(true)
  })

  it('returned ExtensionBuilder cannot be mutated', () => {
    const ext = defineExtension({
      name: 'test',
      apply: () => ({}),
    })

    expect(() => {
      // @ts-expect-error — testing that mutation is blocked
      ext.enforce = 'post'
    }).toThrow()
  })
})
