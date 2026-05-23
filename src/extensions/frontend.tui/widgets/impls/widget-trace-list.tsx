import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { TraceListPayload } from '../../../trace/widget-payloads'

const TRACE_ID_PREVIEW_CHARS = 16
const TRACE_SESSION_PREVIEW_CHARS = 8

const WidgetTraceList: React.FC<{ payload: TraceListPayload }> = ({ payload }) => {
  if (payload.runs.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Trace Runs</Text>
        <Text color="gray"> ({payload.runs.length})</Text>
      </Box>
      {payload.runs.map((r, i) => (
        <Box key={r.id}>
          <Text>
            <Text color="gray" dimColor>{i + 1}.</Text>
            {' '}{r.id.slice(0, TRACE_ID_PREVIEW_CHARS)}
            <Text color="gray" dimColor> session:{(r.sessionId ?? '-').slice(0, TRACE_SESSION_PREVIEW_CHARS)}</Text>
            {' '}{r.totalTurns}t
            <Text color={r.outcome === 'completed' ? 'green' : r.outcome === 'error' ? 'red' : 'yellow'}> {r.outcome}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export const widgetTraceList: WidgetDescriptor<TraceListPayload> = {
  name: 'trace.list',
  Component: WidgetTraceList,
}
