import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { TraceShowPayload } from '../../../trace/widget-payloads'

const TRACE_RUN_ID_PREVIEW_CHARS = 16
const TRACE_EVENT_LIMIT = 20
const TRACE_TIMESTAMP_PREVIEW_CHARS = 19

const WidgetTraceShow: React.FC<{ payload: TraceShowPayload }> = ({ payload }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
    <Box marginBottom={1}>
      <Text bold color="cyan">Trace Run</Text>
      <Text color="gray"> {payload.run.id.slice(0, TRACE_RUN_ID_PREVIEW_CHARS)}</Text>
    </Box>
    {payload.run.events.slice(0, TRACE_EVENT_LIMIT).map((e, i) => (
      <Box key={i}>
        <Text color="gray">{i + 1}.</Text>
        <Text color={e.type === 'tool.error' ? 'red' : undefined}>
          {' '}[T{e.turnIndex}] {e.type}{e.toolName ? ` (${e.toolName})` : ''}
        </Text>
        <Text color="gray" dimColor> {e.timestamp.slice(0, TRACE_TIMESTAMP_PREVIEW_CHARS).replace('T', ' ')}</Text>
      </Box>
    ))}
    {payload.run.events.length > TRACE_EVENT_LIMIT && (
      <Text color="gray" dimColor>  ... and {payload.run.events.length - TRACE_EVENT_LIMIT} more</Text>
    )}
  </Box>
)

export const widgetTraceShow: WidgetDescriptor<TraceShowPayload> = {
  name: 'trace.show',
  Component: WidgetTraceShow,
}
