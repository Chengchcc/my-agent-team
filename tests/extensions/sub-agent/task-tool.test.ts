import { describe, it, expect } from 'bun:test'
import { createTaskTool } from '../../../src/extensions/sub-agent/task-tool'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'
import type { ToolContext } from '../../../src/application/ports/tool-context'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    signal: new AbortController().signal,
    environment: { cwd: '/tmp' },
    sink: { emit: () => {}, flush: () => {} },
    sessionId: 'parent-session',
    turnId: 'parent-turn-1',
    ...overrides,
  }
}

function makeRegistry(): SubAgentRegistry {
  const r = new SubAgentRegistry()
  registerBuiltins(r)
  return r
}

describe('task tool', () => {
  it('has name "task" and dynamic enum from registry', () => {
    const registry = makeRegistry()
    const tool = createTaskTool({ runSubAgent: async () => '', registry })
    expect(tool.name).toBe('task')
    const schema = tool.parameters as Record<string, unknown>
    const props = (schema.properties as Record<string, unknown>)
    const typeEnum = (props.subagent_type as Record<string, unknown>).enum as string[]
    expect(typeEnum).toContain('explore')
    expect(typeEnum).toContain('plan')
    expect(typeEnum).toContain('general-purpose')
  })

  it('parse rejects empty prompt', () => {
    const tool = createTaskTool({ runSubAgent: async () => '', registry: makeRegistry() })
    expect(() => tool.parse?.({ subagent_type: 'explore', description: 'x', prompt: '' }))
      .toThrow('task prompt must not be empty')
  })

  it('parse returns trimmed fields', () => {
    const tool = createTaskTool({ runSubAgent: async () => '', registry: makeRegistry() })
    const result = tool.parse?.({ subagent_type: 'plan', description: ' plan things ', prompt: 'do X' })
    expect(result).toEqual({ subagent_type: 'plan', description: ' plan things ', prompt: 'do X' })
  })

  it('execute calls runSubAgent with correct input mapping', async () => {
    let captured: unknown = null
    const tool = createTaskTool({
      runSubAgent: async (input) => { captured = input; return 'done' },
      registry: makeRegistry(),
    })

    const result = await tool.execute(makeCtx(), {
      subagent_type: 'explore',
      description: 'check the code',
      prompt: 'find all TODO items',
    })

    expect(result).toBe('done')
    expect(captured).toMatchObject({
      type: 'explore',
      prompt: 'find all TODO items',
      parentSessionId: 'parent-session',
      parentTurnId: 'parent-turn-1',
    })
  })

  it('execute passes parentSignal to runSubAgent', async () => {
    const ctrl = new AbortController()
    let capturedSignal: AbortSignal | undefined

    const tool = createTaskTool({
      runSubAgent: async (input) => { capturedSignal = input.parentSignal; return 'ok' },
      registry: makeRegistry(),
    })

    await tool.execute(makeCtx({ signal: ctrl.signal }), {
      subagent_type: 'general-purpose', description: 'fix', prompt: 'fix all bugs',
    })

    expect(capturedSignal).toBe(ctrl.signal)
  })

  it('execute returns error string when runSubAgent throws', async () => {
    const tool = createTaskTool({
      runSubAgent: async () => { throw new Error('sub crash') },
      registry: makeRegistry(),
    })

    await expect(tool.execute(makeCtx(), {
      subagent_type: 'explore', description: 'test', prompt: 'do',
    })).rejects.toThrow('sub crash')
  })
})
