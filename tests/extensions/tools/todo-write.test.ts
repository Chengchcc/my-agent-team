import { describe, it, expect } from 'bun:test'
import { todoWriteExecute, todoWriteSchema } from '../../../src/extensions/tools/todo-write'
import { createToolSink } from '../../../src/application/dispatch'
import type { ToolSinkInternal } from '../../../src/application/ports/tool-sink'
import type { ToolContext } from '../../../src/application/ports/tool-context'

function makeCtx(overrides?: Partial<ToolContext> & { sink?: ToolSinkInternal }): { ctx: ToolContext; sink: ToolSinkInternal } {
  const sink = overrides?.sink ?? createToolSink()
  return {
    sink,
    ctx: {
      signal: new AbortController().signal,
      environment: { cwd: '/tmp' },
      sink,
      sessionId: 's1',
      ...overrides,
    },
  }
}

describe('todo_write tool', () => {
  it('writes todos into sink', async () => {
    const { ctx, sink } = makeCtx()
    await todoWriteExecute({ todos: [{ id: '1', content: 'test', status: 'pending' }] }, ctx)
    expect(sink._todoUpdates).toEqual([{ id: '1', text: 'test', status: 'pending' }])
  })

  it('returns count result', async () => {
    const { ctx } = makeCtx()
    const result = await todoWriteExecute({ todos: [{ id: '1', content: 'test', status: 'pending' }] }, ctx)
    expect(result).toEqual({
      content: 'Recorded 1 todo item(s).',
      isError: false,
    })
  })

  it('content->text field mapping', async () => {
    const { ctx, sink } = makeCtx()
    await todoWriteExecute(
      { todos: [{ id: 'a', content: 'hello world', status: 'completed' }] },
      ctx,
    )
    expect(sink._todoUpdates[0]!.text).toBe('hello world')
    expect(sink._todoUpdates[0]!.status).toBe('completed')
  })

  it('empty list still records (for widget self-hide)', async () => {
    const { ctx, sink } = makeCtx()
    const result = await todoWriteExecute({ todos: [] }, ctx)
    expect(result).toEqual({
      content: 'Recorded 0 todo item(s).',
      isError: false,
    })
    expect(sink._todoUpdates).toHaveLength(0)
  })

  it('multiple todos with correct status', async () => {
    const { ctx, sink } = makeCtx()
    const result = await todoWriteExecute(
      {
        todos: [
          { id: '1', content: 'step one', status: 'in_progress' },
          { id: '2', content: 'step two', status: 'pending' },
        ],
      },
      ctx,
    )
    expect(result).toEqual({
      content: 'Recorded 2 todo item(s).',
      isError: false,
    })
    expect(sink._todoUpdates).toHaveLength(2)
    expect(sink._todoUpdates[0]).toEqual({ id: '1', text: 'step one', status: 'in_progress' })
    expect(sink._todoUpdates[1]).toEqual({ id: '2', text: 'step two', status: 'pending' })
  })
})
