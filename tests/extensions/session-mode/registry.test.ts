import { describe, it, expect } from 'bun:test'
import { ModeRegistry, registerBuiltinModes } from '../../../src/extensions/session-mode/registry'

describe('ModeRegistry', () => {
  it('register stores a descriptor and get retrieves it', () => {
    const r = new ModeRegistry()
    r.register({ name: 'test', description: 'd', systemPromptAppend: 'p', toolFilter: () => true, source: 'builtin' })
    expect(r.get('test')?.name).toBe('test')
  })

  it('get returns undefined for unknown mode', () => {
    const r = new ModeRegistry()
    expect(r.get('nope')).toBeUndefined()
  })

  it('register throws on duplicate builtin mode', () => {
    const r = new ModeRegistry()
    r.register({ name: 'dup', description: 'd', systemPromptAppend: 'p', toolFilter: () => true, source: 'builtin' })
    expect(() =>
      r.register({ name: 'dup', description: 'x', systemPromptAppend: 'q', toolFilter: () => false, source: 'builtin' }),
    ).toThrow('Cannot override builtin mode "dup"')
  })

  it('register allows extension to override extension', () => {
    const r = new ModeRegistry()
    r.register({ name: 'test', description: 'd1', systemPromptAppend: 'p1', toolFilter: () => true, source: 'extension' })
    r.register({ name: 'test', description: 'd2', systemPromptAppend: 'p2', toolFilter: () => false, source: 'extension' })
    expect(r.get('test')?.description).toBe('d2')
  })

  it('list returns all registered modes', () => {
    const r = new ModeRegistry()
    r.register({ name: 'a', description: '', systemPromptAppend: '', toolFilter: () => true, source: 'extension' })
    r.register({ name: 'b', description: '', systemPromptAppend: '', toolFilter: () => true, source: 'extension' })
    expect(r.list()).toHaveLength(2)
  })
})

describe('registerBuiltinModes', () => {
  it('registers plan mode with correct toolFilter', () => {
    const r = new ModeRegistry()
    registerBuiltinModes(r)

    const plan = r.get('plan')!
    expect(plan.name).toBe('plan')
    expect(plan.source).toBe('builtin')
    expect(plan.systemPromptAppend).toContain('Plan Mode')

    // Filter: allows readonly tools
    expect(plan.toolFilter({ name: 'read', description: '', parameters: {}, readonly: true })).toBe(true)
    expect(plan.toolFilter({ name: 'grep', description: '', parameters: {}, readonly: true })).toBe(true)
    expect(plan.toolFilter({ name: 'web_search', description: '', parameters: {}, readonly: true })).toBe(true)

    // Filter: allows todo_write
    expect(plan.toolFilter({ name: 'todo_write', description: '', parameters: {} })).toBe(true)

    // Filter: allows exit_plan_mode
    expect(plan.toolFilter({ name: 'exit_plan_mode', description: '', parameters: {} })).toBe(true)

    // Filter: blocks write tools
    expect(plan.toolFilter({ name: 'bash', description: '', parameters: {} })).toBe(false)
    expect(plan.toolFilter({ name: 'write', description: '', parameters: {} })).toBe(false)
    expect(plan.toolFilter({ name: 'text_editor', description: '', parameters: {} })).toBe(false)

    // Filter: blocks task (sub-agent not allowed in plan mode)
    expect(plan.toolFilter({ name: 'task', description: '', parameters: {} })).toBe(false)
  })
})
