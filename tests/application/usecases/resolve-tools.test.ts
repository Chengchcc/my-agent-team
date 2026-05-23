import { describe, it, expect } from 'bun:test'
import { resolveTools, filterByPermission } from '../../../src/application/usecases/resolve-tools'
import type { ToolDescriptor } from '../../../src/application/usecases/resolve-tools'

describe('ResolveTools usecase', () => {
  const builtin: ToolDescriptor[] = [
    { name: 'bash', description: 'Run bash', parameters: {} },
    { name: 'read', description: 'Read files', parameters: {} },
  ]
  const skill: ToolDescriptor[] = [
    { name: 'web-search', description: 'Search web', parameters: { engine: 'tavily' } },
  ]
  const mcp: ToolDescriptor[] = [
    { name: 'read', description: 'Read files (MCP)', parameters: { cache: true } },
    { name: 'github-issue', description: 'GitHub issues', parameters: {} },
  ]

  describe('resolveTools', () => {
    it('merges all sources with dedup (later wins)', () => {
      const result = resolveTools(builtin, skill, mcp)

      // Should have bash, web-search, read (MCP version), github-issue
      expect(result.length).toBe(4)
      expect(result.map(t => t.name).sort()).toEqual([
        'bash',
        'github-issue',
        'read',
        'web-search',
      ])

      // MCP read should win over builtin read
      const readTool = result.find(t => t.name === 'read')
      expect(readTool?.description).toBe('Read files (MCP)')
    })

    it('whitelist filters correctly', () => {
      const result = resolveTools(builtin, skill, mcp, ['bash', 'web-search'])

      expect(result.length).toBe(2)
      expect(result.map(t => t.name).sort()).toEqual(['bash', 'web-search'])
    })

    it('returns empty when nothing matches whitelist', () => {
      const result = resolveTools(builtin, skill, mcp, ['nonexistent'])
      expect(result).toEqual([])
    })
  })

  describe('filterByPermission', () => {
    it('removes disallowed tools', () => {
      const tools: ToolDescriptor[] = [
        { name: 'bash', description: '', parameters: {} },
        { name: 'read', description: '', parameters: {} },
        { name: 'write', description: '', parameters: {} },
      ]
      const allowed = new Set(['bash', 'read'])

      const result = filterByPermission(tools, allowed)

      expect(result.length).toBe(2)
      expect(result.map(t => t.name)).toEqual(['bash', 'read'])
    })

    it('returns empty when nothing is allowed', () => {
      const tools: ToolDescriptor[] = [
        { name: 'bash', description: '', parameters: {} },
      ]
      const allowed = new Set<string>()

      const result = filterByPermission(tools, allowed)

      expect(result).toEqual([])
    })
  })
})
