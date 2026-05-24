import { describe, it, expect } from 'bun:test'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'

describe('SubAgentRegistry', () => {
  it('register stores a descriptor and get retrieves it', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'test', description: 'd', systemPrompt: 'p', allowedToolNames: ['read'], source: 'extension' })
    expect(r.get('test')?.type).toBe('test')
  })

  it('get returns undefined for unknown type', () => {
    const r = new SubAgentRegistry()
    expect(r.get('nope')).toBeUndefined()
  })

  it('register throws on duplicate builtin type', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'dup', description: 'd1', systemPrompt: 'p', allowedToolNames: [], source: 'builtin' })
    expect(() =>
      r.register({ type: 'dup', description: 'd2', systemPrompt: 'q', allowedToolNames: [], source: 'builtin' }),
    ).toThrow('Cannot override builtin sub-agent type "dup"')
  })

  it('register allows extension to override extension', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'over', description: 'd1', systemPrompt: 'p1', allowedToolNames: [], source: 'extension' })
    r.register({ type: 'over', description: 'd2', systemPrompt: 'p2', allowedToolNames: [], source: 'extension' })
    expect(r.get('over')?.systemPrompt).toBe('p2')
  })

  it('register throws when extension tries to override builtin', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'builtin', description: 'd', systemPrompt: 'p', allowedToolNames: [], source: 'builtin' })
    expect(() =>
      r.register({ type: 'builtin', description: 'x', systemPrompt: 'q', allowedToolNames: [], source: 'extension' }),
    ).toThrow('Cannot override builtin sub-agent type "builtin"')
  })

  it('list returns all registered descriptors', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'a', description: 'a', systemPrompt: 'a', allowedToolNames: [], source: 'extension' })
    r.register({ type: 'b', description: 'b', systemPrompt: 'b', allowedToolNames: [], source: 'extension' })
    expect(r.list()).toHaveLength(2)
  })

  it('clear removes all descriptors', () => {
    const r = new SubAgentRegistry()
    r.register({ type: 'a', description: 'a', systemPrompt: 'a', allowedToolNames: [], source: 'extension' })
    r.clear()
    expect(r.list()).toHaveLength(0)
  })
})

describe('registerBuiltins', () => {
  it('registers explore, plan, and general-purpose', () => {
    const r = new SubAgentRegistry()
    registerBuiltins(r)
    expect(r.get('explore')?.source).toBe('builtin')
    expect(r.get('plan')?.source).toBe('builtin')
    expect(r.get('general-purpose')?.source).toBe('builtin')
  })

  it('explore has only readonly tools + web_search/web_fetch', () => {
    const r = new SubAgentRegistry()
    registerBuiltins(r)
    const desc = r.get('explore')!
    expect(desc.allowedToolNames).toContain('read')
    expect(desc.allowedToolNames).toContain('grep')
    expect(desc.allowedToolNames).toContain('glob')
    expect(desc.allowedToolNames).toContain('ls')
    expect(desc.allowedToolNames).toContain('web_search')
    expect(desc.allowedToolNames).toContain('web_fetch')
    // Must NOT include write tools
    expect(desc.allowedToolNames).not.toContain('bash')
    expect(desc.allowedToolNames).not.toContain('text_editor')
    expect(desc.allowedToolNames).not.toContain('task')
  })

  it('general-purpose has write tools but not task', () => {
    const r = new SubAgentRegistry()
    registerBuiltins(r)
    const desc = r.get('general-purpose')!
    expect(desc.allowedToolNames).toContain('bash')
    expect(desc.allowedToolNames).toContain('text_editor')
    // task must never be in sub-agent whitelist
    expect(desc.allowedToolNames).not.toContain('task')
  })

  it('plan has only read tools, no task/todo_write', () => {
    const r = new SubAgentRegistry()
    registerBuiltins(r)
    const desc = r.get('plan')!
    expect(desc.allowedToolNames).toContain('read')
    expect(desc.allowedToolNames).not.toContain('bash')
    expect(desc.allowedToolNames).not.toContain('task')
  })
})
