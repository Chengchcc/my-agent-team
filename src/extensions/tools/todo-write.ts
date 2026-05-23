import type { ToolContext } from '../../application/ports/tool-context'
import type { TodoWriteArgs } from '../../application/contracts/tool-schemas/todo-write'

export async function todoWriteExecute(
  args: TodoWriteArgs,
  ctx: ToolContext,
): Promise<unknown> {
  ctx.sink.updateTodos(
    args.todos.map(t => ({ id: t.id, text: t.content, status: t.status })),
  )
  return {
    content: `Recorded ${args.todos.length} todo item(s).`,
    isError: false,
  }
}
