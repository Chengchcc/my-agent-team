import { describe, it, expect, beforeEach } from 'bun:test'
import { useTuiStore } from '../../src/extensions/frontend.tui/state/store'

describe('appendWidget replace/append semantics', () => {
  beforeEach(() => {
    useTuiStore.getState().clearActive()
  })

  it('first widget append creates new entry', () => {
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [] }, 'append')
    const { finalized } = useTuiStore.getState()
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ kind: 'widget', blockId: 'w1', widget: 'skills.todo-list' })
  })

  it('replace on nonexistent blockId creates new entry', () => {
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [] }, 'replace')
    const { finalized } = useTuiStore.getState()
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ kind: 'widget', blockId: 'w1', widget: 'skills.todo-list' })
  })

  it('replace on existing blockId replaces in place', () => {
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [{ id: '1', text: 'old' }] }, 'append')
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [{ id: '2', text: 'new' }] }, 'replace')
    const { finalized } = useTuiStore.getState()
    // Should still be 1 entry — replace didn't push a new one
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ kind: 'widget', blockId: 'w1', mode: 'replace' })
    const payload = finalized[0]!.kind === 'widget' ? finalized[0]!.payload as { todos: Array<{ text: string }> } : null
    expect(payload).toBeDefined()
    expect(payload!.todos[0]!.text).toBe('new')
  })

  it('replace finds the LAST matching widget (multiple widgets, same blockId)', () => {
    // Push widget, then some other items, then another widget with same blockId
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [{ id: '1', text: 'first' }] }, 'append')
    useTuiStore.getState().appendSystemNotice('n1', 'hello')
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [{ id: '2', text: 'second' }] }, 'append')

    // Now replace — should replace the second (last) widget entry
    useTuiStore.getState().appendWidget('w1', 'skills.todo-list', { todos: [{ id: '3', text: 'replaced' }] }, 'replace')

    const { finalized } = useTuiStore.getState()
    // 3 items: first widget (untouched), notice, last widget (replaced)
    expect(finalized).toHaveLength(3)

    // First widget still has original payload
    const firstWidget = finalized[0]
    expect(firstWidget!.kind).toBe('widget')
    if (firstWidget!.kind === 'widget') {
      const p = firstWidget.payload as { todos: Array<{ text: string }> }
      expect(p.todos[0]!.text).toBe('first')
    }

    // Middle item is the notice
    expect(finalized[1]!.kind).toBe('system-notice')

    // Last widget was replaced
    const lastWidget = finalized[2]
    expect(lastWidget!.kind).toBe('widget')
    if (lastWidget!.kind === 'widget') {
      const p = lastWidget.payload as { todos: Array<{ text: string }> }
      expect(p.todos[0]!.text).toBe('replaced')
      expect(lastWidget.mode).toBe('replace')
    }
  })
})
