// ToolSink — collection-based side-effect channel for tools.
// Tools call these methods during execute(); dispatcher flushes after the call returns.
// Zero IO. Zero framework imports.

import type { WidgetName, WidgetPayloadFor } from '../contracts/widget-payload-map'

/** Inline-block emit args as seen from a tool (no sessionId — dispatcher fills it). */
export interface ToolInlineBlockArgs<W extends WidgetName = WidgetName> {
  widget: W
  payload: WidgetPayloadFor<W>
  blockId?: string
  mode?: 'append' | 'replace'
}

/** Todo item shape — matches tools/widget-payloads.ts TodoListPayload.todos[number]. */
export interface ToolSinkTodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/** Public surface — what tools see via ctx.sink. */
export interface ToolSink {
  /** Report todo list — REPLACE semantics (not append). */
  updateTodos(todos: ToolSinkTodoItem[]): void

  /** Emit a typed inline-block widget event. */
  emitInlineBlock<W extends WidgetName>(args: ToolInlineBlockArgs<W>): void

  /** Submit a key event for memory extraction (best-effort). */
  emitMemoryHint(hint: string): void

  /** Structured log scoped to this tool call. */
  log(level: 'debug' | 'info' | 'warn', message: string): void
}

/**
 * Internal surface — dispatcher reads collected effects after tool returns.
 * Each call to createToolSink() returns a fresh instance; do NOT cache
 * the inner arrays across tool calls.
 */
export interface ToolSinkInternal extends ToolSink {
  readonly _todoUpdates: ToolSinkTodoItem[]
  readonly _inlineBlocks: ToolInlineBlockArgs[]
  readonly _memoryHints: string[]
  readonly _logs: ReadonlyArray<{ level: 'debug' | 'info' | 'warn'; message: string; ts: number }>
}
