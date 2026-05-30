import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { SubAgentTaskPayload } from '../../../sub-agent/widget-payloads'

const STATUS_COLOR: Record<string, string> = {
  running: 'cyan',
  ok: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const TOOL_STATUS_ICON: Record<string, string> = {
  running: '\u25CF',
  ok: '\u2713',
  error: '\u2717',
}

const FINAL_TEXT_TRUNCATE_LENGTH = 200
const MILLIS_PER_SECOND = 1000
const BYTES_PER_KILO = 1000

function fmtDuration(ms: number): string {
  if (ms < MILLIS_PER_SECOND) return `${ms}ms`
  return `${(ms / MILLIS_PER_SECOND).toFixed(1)}s`
}

function fmtUsage(u?: { input: number; output: number }): string | null {
  if (!u) return null
  const ik = u.input >= BYTES_PER_KILO ? `${(u.input / BYTES_PER_KILO).toFixed(1)}k` : `${u.input}`
  const ok = u.output >= BYTES_PER_KILO ? `${(u.output / BYTES_PER_KILO).toFixed(1)}k` : `${u.output}`
  return `${ik} in / ${ok} out`
}

const WidgetSubAgentTask: React.FC<{ payload: SubAgentTaskPayload }> = ({ payload }) => {
  const [expanded, setExpanded] = useState(false)
  useInput((_input, key) => {
    if (key.return) setExpanded(prev => !prev)
  })
  const color = STATUS_COLOR[payload.status] ?? 'gray'
  const toolCount = payload.innerToolCalls.length
  const durStr = payload.durationMs ? ` \u00b7 ${fmtDuration(payload.durationMs)}` : ''
  const usageStr = fmtUsage(payload.usage)
  const meta = [toolCount > 0 ? `${toolCount} tools` : null, durStr, usageStr]
    .filter(Boolean).join(' \u00b7 ')
  const truncated = payload.finalText && payload.finalText.length > FINAL_TEXT_TRUNCATE_LENGTH

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Box>
        <Text color={color} bold>
          {expanded ? '\u25BC' : '\u25B6'} {payload.subagentType}: {payload.description}
        </Text>
        <Text color={color}> [{payload.status}]</Text>
        {meta ? <Text color="gray"> ({meta})</Text> : null}
      </Box>

      {expanded ? (
        <>
          {payload.innerToolCalls.map((tc, i) => (
            <Box key={tc.innerCallId}>
              <Text>
                <Text color="gray">{i === payload.innerToolCalls.length - 1 ? '  \u2514' : '  \u251C'} </Text>
                <Text color={STATUS_COLOR[tc.status] ?? 'gray'}>
                  {TOOL_STATUS_ICON[tc.status] ?? '?'} {tc.name}
                </Text>
                {tc.durationMs ? <Text color="gray"> ({fmtDuration(tc.durationMs)})</Text> : null}
              </Text>
            </Box>
          ))}
          {payload.finalText ? (
            <>
              <Box>
                <Text color="gray">  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</Text>
              </Box>
              <Box>
                <Text dimColor>
                  {truncated
                    ? payload.finalText!.slice(0, FINAL_TEXT_TRUNCATE_LENGTH) + '...'
                    : payload.finalText}
                </Text>
              </Box>
              {truncated && (
                <Box>
                  <Text color="gray" dimColor>
                    (truncated, see sub session {payload.subSessionId})
                  </Text>
                </Box>
              )}
            </>
          ) : null}
          {payload.errorMessage ? (
            <Box>
              <Text color="red">  Error: {payload.errorMessage}</Text>
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  )
}

export const widgetSubAgentTask: WidgetDescriptor<SubAgentTaskPayload> = {
  name: 'subagent.task',
  Component: WidgetSubAgentTask,
}
