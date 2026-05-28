import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import skillsExt from '../../src/extensions/skills'
import type { SkillDescriptor } from '../../src/domain/skill-descriptor'
import { ExtensionRegistry } from '../../src/kernel/extension-registry'
import { HookContainer } from '../../src/kernel/hook-container'
import { EventBus } from '../../src/kernel/event-bus'
import { RpcRegistry } from '../../src/kernel/rpc-registry'
import type { KernelContext, Logger } from '../../src/kernel/kernel-context'
import { getSettings } from '../../src/config'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAgentPaths } from '../../src/infrastructure/paths/agent-paths'

interface SkillRegistry {
  list: (scope?: string) => SkillDescriptor[]
  get: (name: string) => SkillDescriptor | undefined
  register: (skill: SkillDescriptor) => void
}

function makeTestCtx(agentId = 'test', agentDir?: string): KernelContext {
  const noopLogger: Logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    withTag: () => noopLogger,
  }
  const root = agentDir ?? '/tmp/test-kernel-noop'
  return {
    agentId,
    agentDir: root,
    paths: createAgentPaths(path.dirname(root), path.basename(root)),
    extensions: new ExtensionRegistry(),
    hooks: new HookContainer(),
    bus: new EventBus(),
    rpc: new RpcRegistry(),
    clock: { now: () => Date.now() },
    logger: noopLogger,
    config: {},
  }
}

describe('skills extension', () => {
  let emptyBuiltinDir: string

  beforeAll(async () => {
    await getSettings()
    emptyBuiltinDir = mkdtempSync(path.join(tmpdir(), 'lobster-test-skills-empty-'))
  })

  afterAll(() => {
    rmSync(emptyBuiltinDir, { recursive: true, force: true })
  })

  it('should expose skills.registry capability with 0 skills initially', async () => {
    const k = createTestKernel({ extensions: [skillsExt({ builtinDir: emptyBuiltinDir })] })
    await k.start()

    const registry = k.ctx.extensions.get('skills.registry')
    expect(registry).toBeDefined()
    expect(typeof registry.list).toBe('function')
    expect(typeof registry.get).toBe('function')
    expect(typeof registry.register).toBe('function')

    // No demo skills — skills are loaded from disk via kernelReady hook
    const skills = registry.list()
    expect(skills).toHaveLength(0)

    await k.stop()
  })

  it('should add skill descriptors to tool list via resolveTools hook', async () => {
    const k = createTestKernel({ extensions: [skillsExt({ builtinDir: emptyBuiltinDir })] })
    await k.start()

    // Dispatch resolveTools with empty builtin tool list
    const resolved = (await k.ctx.hooks.dispatch('resolveTools', [])) as Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>

    expect(Array.isArray(resolved)).toBe(true)
    // Skills map starts empty — no demo skills; skills are loaded from disk via kernelReady
    expect(resolved.length).toBe(0)

    await k.stop()
  })

  it('should return all skills via skills.list RPC', async () => {
    const k = createTestKernel({ extensions: [skillsExt({ builtinDir: emptyBuiltinDir })] })
    await k.start()

    const result = (await k.ctx.rpc.resolve('skills.list')!({})) as { skills?: SkillDescriptor[] }

    expect(result).toBeDefined()
    expect(result.skills).toBeDefined()
    // Skills are loaded from disk via kernelReady — none from empty dir
    expect(result.skills!.length).toBe(0)

    await k.stop()
  })

  it('should register, get, and list skills by scope', async () => {
    const k = createTestKernel({ extensions: [skillsExt({ builtinDir: emptyBuiltinDir })] })
    await k.start()

    const registry = k.ctx.extensions.get('skills.registry')

    // Register a new profile-scoped skill
    const customSkill: SkillDescriptor = {
      id: 'skill-custom',
      name: 'custom',
      description: 'Custom skill',
      scope: 'profile',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    registry.register(customSkill)

    // Should be retrievable by name
    const found = registry.get('custom')
    expect(found).toBeDefined()
    expect(found!.name).toBe('custom')
    expect(found!.scope).toBe('profile')

    // List all (only the 1 we registered — no demo skills)
    const all = registry.list()
    expect(all).toHaveLength(1)

    // List by scope
    const builtins = registry.list('builtin')
    expect(builtins).toHaveLength(0)

    const profiles = registry.list('profile')
    expect(profiles).toHaveLength(1)
    expect(profiles[0].name).toBe('custom')

    await k.stop()
  })

  // ── INV-Kernel-3: apply() purity ──

  it('apply() returns synchronously with no top-level await', async () => {
    const ctx = makeTestCtx()
    const ext = skillsExt({ builtinDir: emptyBuiltinDir })
    // apply() must return synchronously — no Promise wrapper from async IO
    const result = ext.apply(ctx)
    // If apply did fire-and-forget async work, the return is still sync.
    // The key: result.hooks must be defined synchronously.
    expect(result).toBeDefined()
    expect(result.hooks).toBeDefined()
  })

  it('skills map empty after apply (no demo skills)', async () => {
    const ctx = makeTestCtx()
    const ext = skillsExt({ builtinDir: emptyBuiltinDir })
    const result = ext.apply(ctx)

    // Register hooks so resolveTools works
    if (result.hooks) {
      for (const [hookName, handler] of Object.entries(result.hooks)) {
        ctx.hooks.register('skills', 'normal', hookName, handler)
      }
    }

    // Simulate kernel registering the extension
    ctx.extensions.register(
      { name: 'skills', enforce: 'normal', dependsOn: [], apply: ext.apply },
      result,
    )

    const registry = ctx.extensions.get('skills.registry')
    expect(registry).toBeDefined()

    // No demo skills — skills map starts empty; file-loaded on kernelReady
    const skills = registry.list()
    expect(skills.length).toBe(0)
  })

  it('registers a kernelReady hook for file-based skill loading', async () => {
    const ctx = makeTestCtx()
    const ext = skillsExt({ builtinDir: emptyBuiltinDir })
    const result = ext.apply(ctx)

    // INV-Kernel-3: file-based loading must be in kernelReady, not in apply
    expect(result.hooks).toBeDefined()
    expect(result.hooks!.kernelReady).toBeDefined()

    const kernelReadyHandler = result.hooks!.kernelReady
    expect(typeof kernelReadyHandler === 'function' || typeof (kernelReadyHandler as any).fn === 'function').toBe(true)
  })

  it('resolveTools emits single Skill tool with enum after kernelReady', async () => {
    const ctx = makeTestCtx()
    const ext = skillsExt()
    const result = ext.apply(ctx)

    // Register hooks
    if (result.hooks) {
      for (const [hookName, handler] of Object.entries(result.hooks)) {
        ctx.hooks.register('skills', 'normal', hookName, handler)
      }
    }
    ctx.extensions.register(
      { name: 'skills', enforce: 'normal', dependsOn: [], apply: ext.apply },
      result,
    )

    // Dispatch kernelReady to trigger file-based skill loading
    await ctx.hooks.dispatch('kernelReady')

    // resolveTools should emit a single Skill tool (not N per-skill tools)
    const resolved = (await ctx.hooks.dispatch('resolveTools', [])) as Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>

    // At least the Skill tool is present when skills are loaded
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    const skillTool = resolved.find(t => t.name === 'Skill')
    expect(skillTool).toBeDefined()
    expect(skillTool!.parameters.type).toBe('object')
    expect(skillTool!.description).toBeTruthy()

    // Loaded skill names are in the enum, not as separate top-level tools
    const nameEnum = (skillTool!.parameters.properties as Record<string, Record<string, unknown>>)?.name?.enum as string[] | undefined
    expect(nameEnum).toBeDefined()
    expect(nameEnum).toContain('skill-creator')
  })
})
