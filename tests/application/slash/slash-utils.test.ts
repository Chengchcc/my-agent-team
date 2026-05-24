import { describe, it, expect } from 'bun:test'
import {
  filterCommands, getSlashQuery, getBestCompletion,
  getHighlightedCommandName, insertSlashCommand, buildPromptSubmission,
} from '../../../src/application/slash/slash-utils'
import type { SlashCommand, SlashResolution, SlashContext } from '../../../src/application/slash/slash-types'

function cmd(name: string, desc = 'desc', overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name, description: desc, source: 'builtin',
    resolve: async (): Promise<SlashResolution> => ({ kind: 'handled' }),
    ...overrides,
  }
}

describe('slash-utils', () => {
  // ── filterCommands ──

  it('filterCommands returns all when filter is empty', () => {
    const cmds = [cmd('compact'), cmd('help'), cmd('exit')]
    expect(filterCommands(cmds, '')).toHaveLength(3)
  })

  it('filterCommands matches by name prefix', () => {
    const cmds = [cmd('compact'), cmd('cost'), cmd('help')]
    const result = filterCommands(cmds, 'co')
    expect(result.map(c => c.name)).toEqual(['compact', 'cost'])
  })

  it('filterCommands sorts startsWith matches before contains matches', () => {
    // Both 'cost' and 'costlog' start with "cost" (score 0).
    // 'abcost' only contains "cost" (score 2). Stable sort keeps prefix matches first.
    const cmds = [cmd('abcost'), cmd('cost'), cmd('costlog')]
    const result = filterCommands(cmds, 'cost')
    expect(result.map(c => c.name).slice(0, 2)).toEqual(['cost', 'costlog'])
  })

  it('filterCommands returns empty when nothing matches', () => {
    const cmds = [cmd('compact'), cmd('help')]
    expect(filterCommands(cmds, 'zzz')).toHaveLength(0)
  })

  // ── getSlashQuery ──

  it('getSlashQuery extracts command name from slash input', () => {
    expect(getSlashQuery('/compact --force')).toBe('compact')
  })

  it('getSlashQuery works with single word', () => {
    expect(getSlashQuery('/help')).toBe('help')
  })

  it('getSlashQuery returns null for non-slash input', () => {
    expect(getSlashQuery('hello world')).toBeNull()
  })

  // ── insertSlashCommand ──

  it('insertSlashCommand formats command with trailing space', () => {
    expect(insertSlashCommand(cmd('compact'))).toBe('/compact ')
  })

  // ── getHighlightedCommandName ──

  it('getHighlightedCommandName returns command name when input matches a known command', () => {
    const cmds = [cmd('compact'), cmd('help')]
    expect(getHighlightedCommandName('/compact ', cmds)).toBe('compact')
  })

  it('getHighlightedCommandName is case-insensitive', () => {
    const cmds = [cmd('Compact')]
    expect(getHighlightedCommandName('/compact ', cmds)).toBe('compact')
  })

  it('getHighlightedCommandName returns null when no match', () => {
    const cmds = [cmd('help')]
    expect(getHighlightedCommandName('/nope ', cmds)).toBeNull()
  })

  // ── getBestCompletion ──

  it('getBestCompletion returns null when no matches', () => {
    expect(getBestCompletion('zz', [cmd('compact')])).toBeNull()
  })

  it('getBestCompletion returns full name when single match', () => {
    expect(getBestCompletion('comp', [cmd('compact')])).toBe('compact')
  })

  it('getBestCompletion returns null when common prefix is not longer than query', () => {
    // common prefix of 'compact','cost' is 'co', same length as query 'co' → null
    expect(getBestCompletion('co', [cmd('compact'), cmd('cost')])).toBeNull()
  })

  it('getBestCompletion returns common prefix longer than query', () => {
    // common prefix of 'cost' and 'compact' starting from 'c' = 'co', longer than 'c'
    expect(getBestCompletion('c', [cmd('cost'), cmd('compact')])).toBe('co')
  })

  it('getBestCompletion returns single match when only one command matches', () => {
    expect(getBestCompletion('comp', [cmd('compact')])).toBe('compact')
  })

  // ── buildPromptSubmission ──

  it('buildPromptSubmission detects skill commands', () => {
    const cmds = [cmd('my-skill', 'a skill', { source: 'skill' })]
    const result = buildPromptSubmission('/my-skill do something', cmds)
    expect(result.requestedSkillName).toBe('my-skill')
    expect(result.text).toBe('/my-skill do something')
  })

  it('buildPromptSubmission ignores non-skill commands', () => {
    const cmds = [cmd('compact', 'compact', { source: 'builtin' })]
    const result = buildPromptSubmission('/compact', cmds)
    expect(result.requestedSkillName).toBeNull()
  })

  it('buildPromptSubmission returns null skill for non-slash text', () => {
    const cmds = [cmd('skill', 'x', { source: 'skill' })]
    const result = buildPromptSubmission('hello', cmds)
    expect(result.requestedSkillName).toBeNull()
    expect(result.text).toBe('hello')
  })
})
