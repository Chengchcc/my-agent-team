import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { MemoryListPayload } from '../../../memory/widget-payloads'

const TYPE_BADGE_MAX_CHARS = 4
const TYPE_LABEL: Record<string, string> = {
  preference: 'PREF',
  fact: 'FACT',
  decision: 'DEC',
  instruction: 'INST',
}

function typeBadge(t: string): { label: string; color: string } {
  const label = TYPE_LABEL[t] ?? t.slice(0, TYPE_BADGE_MAX_CHARS).toUpperCase()
  switch (t) {
    case 'preference': return { label, color: 'yellow' }
    case 'fact': return { label, color: 'blue' }
    case 'decision': return { label, color: 'magenta' }
    case 'instruction': return { label, color: 'cyan' }
    default: return { label, color: 'gray' }
  }
}

const WidgetMemoryList: React.FC<{ payload: MemoryListPayload }> = ({ payload }) => {
  if (payload.entries.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Memories</Text>
        <Text color="gray"> ({payload.entries.length})</Text>
      </Box>
      {payload.entries.map((e, i) => {
        const badge = typeBadge(e.type)
        const preview = e.text.length > 60 ? e.text.slice(0, 60) + '...' : e.text
        return (
          <Box key={e.id}>
            <Text>
              <Text color="gray" dimColor>{i + 1}.</Text>{' '}
              <Text color={badge.color} bold>[{badge.label}]</Text>
              <Text> {preview}</Text>
              <Text color="gray" dimColor> (w:{e.weight.toFixed(2)})</Text>
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export const widgetMemoryList: WidgetDescriptor<MemoryListPayload> = {
  name: 'memory.list',
  Component: WidgetMemoryList,
}
