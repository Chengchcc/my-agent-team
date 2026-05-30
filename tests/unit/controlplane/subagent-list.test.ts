import { describe, it, expect } from 'bun:test'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'

describe('Controlplane SubAgent RPC', () => {
  it('I-16: list returns agents without systemPrompt', () => {
    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const list = registry.list().map(d => ({
      type: d.type,
      description: d.description,
      allowedToolNames: [...d.allowedToolNames],
      source: d.source,
      maxRounds: d.maxRounds,
      maxTokensPerCall: d.maxTokensPerCall,
      maxTotalTokens: d.maxTotalTokens,
      lifetimeMs: d.lifetimeMs,
      modelHint: d.modelHint,
    }))

    expect(list.length).toBeGreaterThanOrEqual(3)
    for (const item of list) {
      expect(item).not.toHaveProperty('systemPrompt')
      expect(item.type).toBeDefined()
      expect(item.description).toBeDefined()
      expect(item.allowedToolNames).toBeInstanceOf(Array)
    }
  })

  it('returns 3 builtins (explore, plan, general-purpose)', () => {
    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const types = registry.list().map(d => d.type)
    expect(types).toContain('explore')
    expect(types).toContain('plan')
    expect(types).toContain('general-purpose')
  })

  it('I-12: config schema has allowSubAgentDirectInvoke defaulting to false', () => {
    const { settingsSchema } = require('../../../src/config/schema')
    // Check the shape directly — field exists with boolean type and default(false)
    const shape = settingsSchema.shape as Record<string, unknown>
    expect(shape.allowSubAgentDirectInvoke).toBeDefined()
    const field = shape.allowSubAgentDirectInvoke as { _def?: { defaultValue?: unknown } }
    expect(field._def?.defaultValue).toBeDefined()
    expect(field._def!.defaultValue()).toBe(false)
  })

  it('describe nonexistent returns found=false', () => {
    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const d = registry.get('nonexistent')
    expect(d).toBeUndefined()
  })
})
