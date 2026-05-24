import { describe, it, expect } from 'bun:test'
import { SlashRegistry } from '../../../src/application/slash/slash-registry'
import type { SlashCommand, SlashContext, SlashResolution } from '../../../src/application/slash/slash-types'

function makeCmd(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name: 'test',
    description: 'a test command',
    source: 'builtin',
    resolve: async (_input: string, _ctx: SlashContext): Promise<SlashResolution> => ({ kind: 'handled' }),
    ...overrides,
  }
}

function makeResolve(result: SlashResolution = { kind: 'handled' }): SlashCommand['resolve'] {
  return async () => result
}

describe('SlashRegistry', () => {
  // ── register ──

  it('registers a command and retrieves by name', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'compact' }))
    expect(reg.get('compact')?.name).toBe('compact')
  })

  it('resolves aliases to the canonical command', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'compact', aliases: ['shrink'] }))
    expect(reg.get('shrink')?.name).toBe('compact')
  })

  it('higher priority source overrides lower (builtin > ext > agent > skill)', () => {
    const reg = new SlashRegistry()
    // skill=3 (lowest), ext=1 → ext wins
    reg.register(makeCmd({ name: 'foo', source: 'skill' }))
    reg.register(makeCmd({ name: 'foo', source: 'ext' }))
    expect(reg.get('foo')?.source).toBe('ext')
  })

  it('lower priority source does not override higher', () => {
    const reg = new SlashRegistry()
    // builtin=0 (highest), skill=3 (lowest) → builtin sticks
    reg.register(makeCmd({ name: 'foo', source: 'builtin' }))
    reg.register(makeCmd({ name: 'foo', source: 'skill' }))
    expect(reg.get('foo')?.source).toBe('builtin')
  })

  it('same-source duplicate keeps first registration', () => {
    const reg = new SlashRegistry()
    const first = makeCmd({ name: 'foo', source: 'builtin', description: 'first' })
    const second = makeCmd({ name: 'foo', source: 'builtin', description: 'second' })
    reg.register(first)
    reg.register(second)
    expect(reg.get('foo')?.description).toBe('first')
  })

  // ── resolve ──

  it('resolves "/command args" into ParsedSlash', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'compact' }))
    const parsed = reg.resolve('/compact --force')
    expect(parsed?.command.name).toBe('compact')
    expect(parsed?.argv).toEqual(['--force'])
  })

  it('resolves command with no extra whitespace', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'help' }))
    const parsed = reg.resolve('/help')
    expect(parsed?.command.name).toBe('help')
    expect(parsed?.argv).toEqual([])
  })

  it('returns null for unknown command', () => {
    const reg = new SlashRegistry()
    expect(reg.resolve('/nope')).toBeNull()
  })

  it('returns null for non-slash input', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'help' }))
    expect(reg.resolve('hello')).toBeNull()
  })

  it('returns null for empty string', () => {
    const reg = new SlashRegistry()
    expect(reg.resolve('')).toBeNull()
  })

  // ── list / filter ──

  it('lists all registered commands', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'a', source: 'builtin' }))
    reg.register(makeCmd({ name: 'b', source: 'ext' }))
    expect(reg.list()).toHaveLength(2)
  })

  it('filters by source', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'a', source: 'builtin' }))
    reg.register(makeCmd({ name: 'b', source: 'ext' }))
    expect(reg.list({ source: 'ext' })).toHaveLength(1)
    expect(reg.list({ source: 'ext' })[0]!.name).toBe('b')
  })

  it('filters by group', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'a', source: 'builtin', group: 'core' }))
    reg.register(makeCmd({ name: 'b', source: 'builtin', group: 'debug' }))
    expect(reg.list({ group: 'debug' })).toHaveLength(1)
  })

  // ── unregister ──

  it('unregister removes command and aliases', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'compact', aliases: ['shrink'] }))
    reg.unregister('compact')
    expect(reg.get('compact')).toBeUndefined()
    expect(reg.get('shrink')).toBeUndefined()
  })

  it('unregister of unknown command is a no-op', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'help' }))
    reg.unregister('nope')
    expect(reg.get('help')).toBeDefined()
  })

  it('unregisterBySource removes all commands from a source', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'a', source: 'ext' }))
    reg.register(makeCmd({ name: 'b', source: 'ext' }))
    reg.register(makeCmd({ name: 'c', source: 'builtin' }))
    reg.unregisterBySource('ext')
    expect(reg.list()).toHaveLength(1)
    expect(reg.get('c')?.name).toBe('c')
  })

  // ── getGroups ──

  it('getGroups returns commands grouped by group field', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'help', source: 'builtin', group: 'core' }))
    reg.register(makeCmd({ name: 'exit', source: 'builtin', group: 'core' }))
    reg.register(makeCmd({ name: 'cost', source: 'builtin', group: 'debug' }))
    const groups = reg.getGroups()
    expect(groups).toHaveLength(2)
    const core = groups.find(g => g.name === 'core')
    expect(core?.commands).toHaveLength(2)
  })

  it('getGroups defaults to "other" group when not specified', () => {
    const reg = new SlashRegistry()
    reg.register(makeCmd({ name: 'foo', source: 'builtin' }))
    const groups = reg.getGroups()
    expect(groups[0]!.name).toBe('other')
  })
})
