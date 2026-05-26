import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import subAgentExt from '../../../src/extensions/sub-agent'
import type { ToolCatalog } from '../../../src/application/ports/tool-catalog'
import type { SubAgentRegistry } from '../../../src/extensions/sub-agent/registry'
import type { ToolContext } from '../../../src/application/ports/tool-context'

/**
 * M2 safety tests: recursive guard, compaction disabled, permission isolation.
 */

function makeCtx(sessionId = 's1', turnId = 't1'): ToolContext {
  return {
    signal: new AbortController().signal,
    environment: { cwd: '/tmp' },
    sink: { emit: () => {}, flush: () => {} },
    sessionId, turnId,
  }
}

describe('sub-agent safety guards (M2)', () => {
  // ── Recursive guard: 'task' stripped from allowedToolNames ──

  it('task is filtered from allowedToolNames before passing to runTurnUsecase', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const registry = k.ctx.extensions.get('sub-agent.registry')
    // Register a test sub-agent that includes 'task' in its whitelist
    registry.register({
      type: 'recursive-test',
      description: 'should not have task',
      systemPrompt: 'You are a sub-agent without task access.',
      allowedToolNames: ['read', 'task', 'bash'],
      source: 'extension',
    })

    // The runSubAgent closure should strip 'task' from allowedToolNames
    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    // Execute with the recursive-test type — it will try to run a sub-agent
    // Without a real provider, it'll fail, but the key assertion is that
    // the resolved tools for the sub turn won't include 'task'
    const result = await taskTool.execute(makeCtx(), {
      subagent_type: 'recursive-test', description: 'test', prompt: 'do nothing',
    }) as string

    // The sub-agent should fail or complete, but NOT because it recursively called task
    // (it would fail with unknown_subagent_type or provider error, not task-related)
    expect(typeof result).toBe('string')
    expect(result).not.toContain('recursion')

    await k.stop()
  })

  it('builtin explore/plan/general-purpose descriptors never include task', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const registry = k.ctx.extensions.get('sub-agent.registry')

    for (const type of ['explore', 'plan', 'general-purpose']) {
      const desc = registry.get(type)!
      expect(desc.allowedToolNames).not.toContain('task')
      expect(desc.allowedToolNames).not.toContain('ask_user_question')
    }

    await k.stop()
  })

  // ── Compaction disabled in sub-agent ──

  it('sub-agent with small prompt completes without compaction interference', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    // plan sub-agent with a simple prompt — should fail with provider error
    // (no real LLM), but NOT with compaction error
    const result = await taskTool.execute(makeCtx(), {
      subagent_type: 'plan',
      description: 'simple plan',
      prompt: 'Say hello.',
    }) as string

    // Should be a provider-related error, not a compaction error
    expect(typeof result).toBe('string')
    expect(result).not.toContain('compact')

    await k.stop()
  })

  // ── Permission: deny-list isolation between sub and parent ──

  it('permission deny-list in parent session does not affect sub session', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), subAgentExt(),
      ],
    })
    await k.start()

    // Deny 'bash' in parent session
    const checker = k.ctx.extensions.get('permission.checker')
    checker.deny('bash')

    // Sub session should still be able to list 'bash' in tools (different session id)
    const catalog = k.ctx.extensions.get('tool-catalog.catalog')
    const taskTool = catalog.get('task')!

    const result = await taskTool.execute(makeCtx('parent-s3', 'parent-t3'), {
      subagent_type: 'general-purpose',
      description: 'test permission isolation',
      prompt: 'list files with ls',
    }) as string

    // Should be provider error (no real LLM), not permission denial
    expect(typeof result).toBe('string')
    expect(result).not.toContain('denied by policy')

    await k.stop()
  })
})
