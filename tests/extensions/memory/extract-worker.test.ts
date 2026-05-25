import { describe, it, expect } from 'bun:test'
import { parseCandidates } from '../../../src/extensions/memory/extract-worker'

describe('parseCandidates', () => {
  it('parses single candidate with one tag', () => {
    const result = parseCandidates('#preference\nUser prefers ripgrep over grep.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('User prefers ripgrep over grep.')
    expect(result[0]!.tags).toEqual(['preference'])
    expect(result[0]!.weight).toBe(1)
  })

  it('parses multiple tags on first line', () => {
    const result = parseCandidates('#preference #tools\nUser likes bash.')
    expect(result).toHaveLength(1)
    expect(result[0]!.tags).toEqual(['preference', 'tools'])
  })

  it('parses multiple candidates separated by blank line', () => {
    const result = parseCandidates('#fact\nSky is blue.\n\n#preference\nUser likes dark themes.')
    expect(result).toHaveLength(2)
  })

  it('skips block without any #tag', () => {
    const result = parseCandidates('No tags here.\n\n#fact\nHas a fact.')
    expect(result).toHaveLength(1)
  })

  it('skips block with tags but empty body', () => {
    const result = parseCandidates('#preference\n\n#fact\nReal fact here.')
    expect(result).toHaveLength(1)
  })

  it('handles Windows-style line endings (\\r\\n)', () => {
    const result = parseCandidates('#fact\r\nFact body.\r\n\r\n#preference\r\nPref body.')
    expect(result).toHaveLength(2)
  })

  it('returns empty array for "NONE" sentinel', () => {
    const result = parseCandidates('NONE')
    expect(result).toEqual([])
  })

  it('handles multi-line body text', () => {
    const result = parseCandidates('#decision\nFirst line.\nSecond line.\nThird line.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('First line.\nSecond line.\nThird line.')
  })

  it('tags are lowercased', () => {
    const result = parseCandidates('#Preference #TOOLS\nBody.')
    expect(result[0]!.tags).toEqual(['preference', 'tools'])
  })
})
