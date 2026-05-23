export interface TodoListPayload {
  readonly todos: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  }>
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'skills.todo-list': TodoListPayload
  }
}
