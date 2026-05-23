import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { TodoListPayload } from '../../../tools/widget-payloads'

type Status = TodoListPayload['todos'][number]['status']

const STATUS_SYMBOL: Record<Status, string> = {
  pending: '○', in_progress: '◉', completed: '✓', cancelled: '✗',
}

function statusStyle(s: Status) {
  switch (s) {
    case 'pending':     return { color: 'gray' as const, dimColor: true }
    case 'in_progress': return { color: 'yellow' as const, bold: true }
    case 'completed':   return { color: 'green' as const, strikethrough: true, dimColor: true }
    case 'cancelled':   return { color: 'gray' as const, strikethrough: true }
  }
}

const WidgetTodoList: React.FC<{ payload: TodoListPayload }> = ({ payload }) => {
  if (payload.todos.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Todo List</Text>
      </Box>
      {payload.todos.map((t, i) => {
        const sty = statusStyle(t.status as Status)
        const sym = STATUS_SYMBOL[t.status as Status]
        return (
          <Box key={t.id}>
            <Text>
              <Text color="gray" dimColor>{i + 1}.</Text>{' '}
              <Text {...sty}>{sym} {t.text}</Text>
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export const widgetTodoList: WidgetDescriptor<TodoListPayload> = {
  name: 'skills.todo-list',
  Component: WidgetTodoList,
}
