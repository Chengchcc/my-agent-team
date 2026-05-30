import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { SubAgentTaskPayload } from '../../../sub-agent/widget-payloads'

import type { SubAgentErrorType } from '../../../../application/contracts/subagent-events'

const STATUS_COLOR: Record<string, string> = {
  running: 'cyan',
  ok: 'green',
  warn: 'yellow',
  failed: 'red',
  cancelled: 'gray',
}

const ERROR_LABELS: Record<SubAgentErrorType, { label: string; severity: 'warn' | 'error' }> = {
  cancelled:            { label: 'Cancelled',             severity: 'warn' },
  failed:               { label: 'Failed',                severity: 'error' },
  busy:                 { label: 'Too many concurrent',   severity: 'error' },
  unknown_type:         { label: 'Unknown type',          severity: 'error' },
  budget:               { label: 'Budget exhausted',      severity: 'warn' },
  max_rounds:           { label: 'Max rounds reached',    severity: 'warn' },
  response_truncated:   { label: 'Output truncated',      severity: 'warn' },
  empty_response:       { label: 'Empty response',        severity: 'warn' },
  response_filtered:    { label: 'Content filtered',      severity: 'error' },
  tool_unavailable:     { label: 'Tool not allowed',      severity: 'error' },
  tool_failed:          { label: 'Tool failed',           severity: 'error' },
  provider_inconsistent: { label: 'Provider inconsistent', severity: 'error' },
  llm_failed:           { label: 'LLM failed',            severity: 'error' },
}

const STATUS_ICON: Record<string, string> = {
  running: '\u25CF',
  ok: '\u2713',
  cancelled: '\u2717',
  failed: '\u2717',
}

const ERROR_MSG_MAX = 80
const ELLIPSIS_LEN = 3

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtUsage(u?: { input: number; output: number }): string | null {
  if (!u) return null
  const ik = u.input >= 1000 ? `${(u.input / 1000).toFixed(1)}k` : `${u.input}`
  const ok = u.output >= 1000 ? `${(u.output / 1000).toFixed(1)}k` : `${u.output}`
  return `${ik} in / ${ok} out`
}

const WidgetSubAgentTask: React.FC<{ payload: SubAgentTaskPayload }> = ({ payload }) => {
  const color = STATUS_COLOR[payload.status] ?? 'gray'
  const icon = STATUS_ICON[payload.status] ?? '\u25CF'
  const toolCount = payload.innerToolCalls.length
  const durStr = payload.durationMs ? ` \u00b7 ${fmtDuration(payload.durationMs)}` : ''
  const usageStr = fmtUsage(payload.usage)
  const meta = [toolCount > 0 ? `${toolCount} tools` : null, durStr, usageStr]
    .filter(Boolean).join(' \u00b7 ')
  const errorLabel = payload.errorType && ERROR_LABELS[payload.errorType]
    ? ERROR_LABELS[payload.errorType].label : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Box>
        <Text color={color} bold>
          {icon} {payload.subagentType}: {payload.description}
        </Text>
        <Text color={color}>
          {' '}[{errorLabel ?? payload.status}]
        </Text>
        {meta ? <Text color="gray"> ({meta})</Text> : null}
      </Box>
      {payload.errorMessage ? (
        <Box>
          <Text color={payload.errorType && ERROR_LABELS[payload.errorType]?.severity === 'warn' ? 'yellow' : 'red'}>
            {'\u2514 '}{errorLabel ?? 'Error'}: {payload.errorMessage.length > ERROR_MSG_MAX ? payload.errorMessage.slice(0, ERROR_MSG_MAX - ELLIPSIS_LEN) + '\u2026' : payload.errorMessage}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export const widgetSubAgentTask: WidgetDescriptor<SubAgentTaskPayload> = {
  name: 'subagent.task',
  Component: WidgetSubAgentTask,
}
