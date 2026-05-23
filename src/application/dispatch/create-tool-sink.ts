import type {
  ToolSinkInternal, ToolSinkTodoItem, ToolInlineBlockArgs,
} from '../ports/tool-sink'
import type { WidgetName } from '../contracts/widget-payload-map'
import { emitInlineBlock as busEmitInlineBlock } from '../contracts'

/** Bus port — minimal shape the flush helper needs. */
export interface SinkBusPort {
  emit(type: string, payload: unknown): void
}

export function createToolSink(): ToolSinkInternal {
  let collectedTodos: ToolSinkTodoItem[] = []
  let collectedBlocks: ToolInlineBlockArgs[] = []
  const collectedHints: string[] = []
  const collectedLogs: Array<{ level: 'debug' | 'info' | 'warn'; message: string; ts: number }> = []

  const sink: ToolSinkInternal = {
    updateTodos(todos) {
      collectedTodos = todos.slice()   // defensive copy — caller may mutate input
    },
    emitInlineBlock<W extends WidgetName>(args: ToolInlineBlockArgs<W>) {
      collectedBlocks.push(args as ToolInlineBlockArgs)
    },
    emitMemoryHint(hint) {
      if (hint.length > 0) collectedHints.push(hint)
    },
    log(level, message) {
      collectedLogs.push({ level, message, ts: Date.now() })
    },
    get _todoUpdates() { return collectedTodos },
    get _inlineBlocks() { return collectedBlocks },
    _memoryHints: collectedHints,
    _logs: collectedLogs,
  }
  return sink
}

/**
 * Project collected effects from a sink onto the bus.
 * Called by dispatcher AFTER the tool returns successfully.
 * On error: caller drops everything (do not call this).
 */
export function flushSink(
  sink: ToolSinkInternal,
  bus: SinkBusPort,
  sessionId: string,
): void {
  // 1. Todos → tui.inline-block (skills.todo-list, replace mode, stable blockId)
  if (sink._todoUpdates.length > 0) {
    busEmitInlineBlock(bus, {
      sessionId,
      widget: 'skills.todo-list',
      payload: { todos: sink._todoUpdates },
      blockId: 'todo-list',
      mode: 'replace',
    })
  }

  // 2. Arbitrary inline-blocks (order preserved)
  for (const ib of sink._inlineBlocks) {
    busEmitInlineBlock(bus, {
      sessionId,
      widget: ib.widget,
      payload: ib.payload,
      blockId: ib.blockId,
      mode: ib.mode,
    })
  }

  // 3. Memory hints → memory.hint bus event
  for (const hint of sink._memoryHints) {
    bus.emit('memory.hint', { sessionId, hint, ts: Date.now() })
  }

  // 4. Logs → logger.tool bus event
  for (const entry of sink._logs) {
    bus.emit('logger.tool', { sessionId, ...entry })
  }
}
