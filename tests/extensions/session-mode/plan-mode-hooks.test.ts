import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestKernel } from '../../helpers/kernel-helper'
import traceExt from '../../../src/extensions/trace'
import sessionExt from '../../../src/extensions/session'
import toolCatalogExt from '../../../src/extensions/tool-catalog'
import toolsExt from '../../../src/extensions/tools'
import permissionExt from '../../../src/extensions/permission'
import sessionModeExt from '../../../src/extensions/session-mode'
import type { SessionStore } from '../../../src/application/ports/session-store'

describe('plan mode hooks (M1)', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'plan-hooks-'))
  // ── transformPrompt: injects PLAN_MODE_PROMPT when session mode is plan ──

  it('transformPrompt injects PLAN_MODE_PROMPT when session mode is plan', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    // Set main session to plan mode
    const store = k.ctx.extensions.get('session.store')
    const main = await store.load('tui-default')
    main!.mode = 'plan'
    await store.save(main!)

    // Dispatch with sessionId in input object
    const result = await k.ctx.hooks.dispatch('transformPrompt', {
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 'tui-default',
    }) as { system: string }

    expect(result.system).toContain('Plan Mode')
    expect(result.system).toContain('You are in **Plan Mode**')

    await k.stop()
  })

  it('transformPrompt does NOT inject plan prompt when mode is normal', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    const result = await k.ctx.hooks.dispatch('transformPrompt', {
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 'tui-default',
    }) as { system: string }

    // tools extension always appends TODO_WRITE_GUIDANCE — accept that
    expect(result.system).toContain('You are helpful.')
    expect(result.system).not.toContain('Plan Mode')

    await k.stop()
  })

  // ── resolveTools: filters to readonly + todo_write + exit_plan_mode ──

  it('resolveTools filters to readonly+todo_write+exit_plan_mode in plan mode', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    const store = k.ctx.extensions.get('session.store')
    const main = await store.load('tui-default')
    main!.mode = 'plan'
    await store.save(main!)

    const allTools = [
      { name: 'read', description: '', parameters: {}, readonly: true },
      { name: 'grep', description: '', parameters: {}, readonly: true },
      { name: 'bash', description: '', parameters: {} },
      { name: 'write', description: '', parameters: {} },
      { name: 'text_editor', description: '', parameters: {} },
      { name: 'todo_write', description: '', parameters: {} },
      { name: 'web_search', description: '', parameters: {}, readonly: true },
      { name: 'exit_plan_mode', description: '', parameters: {}, readonly: true },
      { name: 'task', description: '', parameters: {} },
    ]

    // Pass sessionId as second arg (new resolveTools dispatch)
    const filtered = await k.ctx.hooks.dispatch('resolveTools', allTools, 'tui-default') as Array<{ name: string }>
    const names = filtered.map(t => t.name)

    // Allowed
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).toContain('web_search')
    expect(names).toContain('todo_write')
    expect(names).toContain('exit_plan_mode')

    // Blocked
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
    expect(names).not.toContain('text_editor')
    expect(names).not.toContain('task')

    await k.stop()
  })

  it('resolveTools returns all tools in normal mode', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    const allTools = [
      { name: 'read', description: '', parameters: {}, readonly: true },
      { name: 'bash', description: '', parameters: {} },
    ]

    // tools extension adds more tools (glob, ls, etc.) — accept that
    const result = await k.ctx.hooks.dispatch('resolveTools', allTools, 'tui-default') as Array<{ name: string }>
    expect(result.length).toBeGreaterThanOrEqual(2)

    await k.stop()
  })

  // ── onToolCall: guard blocks write tools in plan mode ──

  it('onToolCall guard blocks bash in plan mode', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    const store = k.ctx.extensions.get('session.store')
    const main = await store.load('tui-default')
    main!.mode = 'plan'
    await store.save(main!)

    let err: Error | null = null
    try {
      await k.ctx.hooks.dispatch('onToolCall',
        { name: 'bash', id: 'b1' },
        { sessionId: 'tui-default' },
      )
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('not allowed in')
    expect(err!.message).toContain('plan')

    await k.stop()
  })

  it('onToolCall guard allows read (readonly) in plan mode', async () => {
    const k = createTestKernel({
      extensions: [
        traceExt(), sessionExt(), toolCatalogExt(),
        toolsExt(), permissionExt(), sessionModeExt(),
      ],
    })
    await k.start()

    const store = k.ctx.extensions.get('session.store')
    const main = await store.load('tui-default')
    main!.mode = 'plan'
    await store.save(main!)

    // read is readonly in catalog — guard should allow it (not throw)
    // Tool may fail (no file), but guard must not be the one blocking
    let guardError: Error | null = null
    try {
      await k.ctx.hooks.dispatch('onToolCall',
        { name: 'read', id: 'r1', arguments: { path: '/tmp/nonexistent-test-file' } },
        { sessionId: 'tui-default' },
      )
    } catch (e) {
      guardError = e as Error
    }
    // If there's an error, it should NOT be the guard's "not allowed in plan mode"
    if (guardError) {
      expect(guardError.message).not.toContain('not allowed in')
      expect(guardError.message).not.toContain('plan')
    }

    await k.stop()
  })
})
