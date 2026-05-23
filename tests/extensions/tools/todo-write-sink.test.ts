import { describe, test, expect } from 'bun:test'
import { todoWriteExecute } from '../../../src/extensions/tools/todo-write'
import { createToolSink } from '../../../src/application/dispatch'
import type { ToolContext } from '../../../src/application/ports/tool-context'

function makeCtx(): { ctx: ToolContext; sink: ReturnType<typeof createToolSink> } {
  const sink = createToolSink()
  return {
    sink,
    ctx: {
      signal: new AbortController().signal,
      environment: { cwd: '/tmp' },
      sink,
      sessionId: 's1',
    },
  }
}

describe('todoWriteExecute -> sink', () => {
  test('writes todos into sink with field rename content->text', async () => {
    const { ctx, sink } = makeCtx()
    const r = await todoWriteExecute(
      { todos: [{ id: '1', content: 'do x', status: 'pending' }] },
      ctx,
    )
    expect(sink._todoUpdates).toEqual([{ id: '1', text: 'do x', status: 'pending' }])
    expect((r as { isError: boolean }).isError).toBe(false)
  })

  test('empty todo list still records', async () => {
    const { ctx, sink } = makeCtx()
    sink.updateTodos([{ id: 'old', text: 'old', status: 'pending' }])
    await todoWriteExecute({ todos: [] }, ctx)
    expect(sink._todoUpdates).toEqual([])
  })

  test('returns count message', async () => {
    const { ctx } = makeCtx()
    const r = await todoWriteExecute({ todos: [
      { id: '1', content: 'a', status: 'pending' },
      { id: '2', content: 'b', status: 'in_progress' },
    ] }, ctx)
    expect((r as { content: string }).content).toContain('2 todo')
  })
})
