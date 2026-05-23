import { describe, test, expect } from 'bun:test'
import { createToolSink, flushSink } from '../../src/application/dispatch'
import type { ToolSinkTodoItem } from '../../src/application/ports/tool-sink'

// ── Recorder bus for assertions ────────────────────────────────────────────
function makeRecorder() {
  const events: Array<{ type: string; payload: unknown }> = []
  return {
    bus: { emit: (type: string, payload: unknown) => events.push({ type, payload }) },
    events,
  }
}

describe('createToolSink', () => {
  test('starts empty', () => {
    const s = createToolSink()
    expect(s._todoUpdates).toEqual([])
    expect(s._inlineBlocks).toEqual([])
    expect(s._memoryHints).toEqual([])
    expect(s._logs).toEqual([])
  })

  test('updateTodos replaces wholesale on each call', () => {
    const s = createToolSink()
    const a: ToolSinkTodoItem = { id: '1', text: 'a', status: 'pending' }
    const b: ToolSinkTodoItem = { id: '2', text: 'b', status: 'in_progress' }
    s.updateTodos([a])
    s.updateTodos([b])
    expect(s._todoUpdates).toEqual([b])
  })

  test('updateTodos copies input — mutating caller array does NOT affect sink', () => {
    const s = createToolSink()
    const input: ToolSinkTodoItem[] = [{ id: '1', text: 'a', status: 'pending' }]
    s.updateTodos(input)
    input.push({ id: '2', text: 'b', status: 'pending' })
    expect(s._todoUpdates).toHaveLength(1)
    expect(s._todoUpdates[0]!.id).toBe('1')
  })

  test('emitInlineBlock collects in order with widget type preserved', () => {
    const s = createToolSink()
    s.emitInlineBlock({ widget: 'skills.todo-list', payload: { todos: [] }, blockId: 'a', mode: 'replace' })
    s.emitInlineBlock({ widget: 'skills.todo-list', payload: { todos: [] }, blockId: 'b', mode: 'append' })
    expect(s._inlineBlocks.map(x => x.blockId)).toEqual(['a', 'b'])
    expect(s._inlineBlocks[1]!.mode).toBe('append')
  })

  test('emitMemoryHint skips empty strings', () => {
    const s = createToolSink()
    s.emitMemoryHint('something')
    s.emitMemoryHint('')
    expect(s._memoryHints).toEqual(['something'])
  })

  test('log captures level + message + timestamp', () => {
    const s = createToolSink()
    s.log('warn', 'oops')
    expect(s._logs).toHaveLength(1)
    expect(s._logs[0]!.level).toBe('warn')
    expect(s._logs[0]!.message).toBe('oops')
    expect(typeof s._logs[0]!.ts).toBe('number')
  })
})

describe('flushSink', () => {
  test('empty sink → no bus events', () => {
    const { bus, events } = makeRecorder()
    flushSink(createToolSink(), bus, 'sess-x')
    expect(events).toHaveLength(0)
  })

  test('todos → one tui.inline-block (skills.todo-list, replace, blockId=todo-list)', () => {
    const { bus, events } = makeRecorder()
    const s = createToolSink()
    s.updateTodos([{ id: '1', text: 'a', status: 'pending' }])
    flushSink(s, bus, 'sess-x')
    const ib = events.find(e => e.type === 'tui.inline-block')
    expect(ib).toBeDefined()
    const inner = (ib!.payload as { payload: Record<string, unknown> }).payload
    expect(inner.widget).toBe('skills.todo-list')
    expect(inner.blockId).toBe('todo-list')
    expect(inner.mode).toBe('replace')
    expect(inner.sessionId).toBe('sess-x')
  })

  test('multiple inline-blocks emitted in order', () => {
    const { bus, events } = makeRecorder()
    const s = createToolSink()
    s.emitInlineBlock({ widget: 'skills.todo-list', payload: { todos: [] }, blockId: 'A' })
    s.emitInlineBlock({ widget: 'skills.todo-list', payload: { todos: [] }, blockId: 'B' })
    flushSink(s, bus, 'sess-x')
    const ibs = events.filter(e => e.type === 'tui.inline-block')
    expect(ibs.map(e => (e.payload as { payload: { blockId: string } }).payload.blockId)).toEqual(['A', 'B'])
  })

  test('todos + custom inline-blocks coexist: todos first, then customs', () => {
    const { bus, events } = makeRecorder()
    const s = createToolSink()
    s.updateTodos([{ id: '1', text: 'a', status: 'pending' }])
    s.emitInlineBlock({ widget: 'skills.todo-list', payload: { todos: [] }, blockId: 'X' })
    flushSink(s, bus, 'sess-x')
    const ibs = events.filter(e => e.type === 'tui.inline-block')
    expect((ibs[0]!.payload as { payload: { blockId: string } }).payload.blockId).toBe('todo-list')
    expect((ibs[1]!.payload as { payload: { blockId: string } }).payload.blockId).toBe('X')
  })

  test('memory hints → one memory.hint event per hint, with sessionId', () => {
    const { bus, events } = makeRecorder()
    const s = createToolSink()
    s.emitMemoryHint('h1'); s.emitMemoryHint('h2')
    flushSink(s, bus, 'sess-x')
    const hints = events.filter(e => e.type === 'memory.hint')
    expect(hints).toHaveLength(2)
    expect((hints[0]!.payload as { hint: string }).hint).toBe('h1')
    expect((hints[0]!.payload as { sessionId: string }).sessionId).toBe('sess-x')
  })

  test('logs → one logger.tool event per entry, sessionId stamped', () => {
    const { bus, events } = makeRecorder()
    const s = createToolSink()
    s.log('info', 'msg1'); s.log('warn', 'msg2')
    flushSink(s, bus, 'sess-x')
    const logs = events.filter(e => e.type === 'logger.tool')
    expect(logs).toHaveLength(2)
    expect((logs[0]!.payload as { message: string }).message).toBe('msg1')
    expect((logs[1]!.payload as { level: string }).level).toBe('warn')
    expect((logs[0]!.payload as { sessionId: string }).sessionId).toBe('sess-x')
  })
})
