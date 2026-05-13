import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../state/store';
import type { UITodoItem } from '../state/types';

const STATUS_SYMBOL: Record<UITodoItem['status'], string> = {
  pending: '○',
  in_progress: '◉',
  completed: '✓',
  cancelled: '✗',
};

function getStatusStyle(status: UITodoItem['status']) {
  switch (status) {
    case 'pending':
      return { color: 'gray' as const, dimColor: true };
    case 'in_progress':
      return { color: 'yellow' as const, bold: true };
    case 'completed':
      return { color: 'green' as const, strikethrough: true, dimColor: true };
    case 'cancelled':
      return { color: 'gray' as const, strikethrough: true };
  }
}

function TodoPanel(): React.ReactElement | null {
  const todos = useTuiStore((s) => s.todos);

  const depKey = todos.map((t: UITodoItem) => t.id + t.status).join(',');
  const items = useMemo(() => todos, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Todo List</Text>
      </Box>
      {items.map((todo, index) => {
        const style = getStatusStyle(todo.status);
        const symbol = STATUS_SYMBOL[todo.status];

        return (
          <Box key={todo.id} marginBottom={0.5}>
            <Text>
              <Text color="gray" dimColor>{index + 1}.</Text>
              {' '}
              <Text {...style}>{symbol} {todo.content}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export { TodoPanel };
