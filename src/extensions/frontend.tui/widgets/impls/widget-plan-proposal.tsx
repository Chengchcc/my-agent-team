import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { PlanProposalPayload } from '../../../session-mode/widget-payloads'

const PLAN_PREVIEW_CHARS = 200

const STATUS_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  proposed: { icon: '●', color: 'yellow', label: 'Plan Proposal' },
  approved: { icon: '✓', color: 'green', label: 'Plan Approved' },
  rejected: { icon: '✗', color: 'red', label: 'Plan Rejected' },
  kept: { icon: '−', color: 'gray', label: 'Plan Kept (still in plan mode)' },
  superseded: { icon: '⊘', color: 'gray', label: 'Superseded' },
}

const WidgetPlanProposal: React.FC<{ payload: PlanProposalPayload }> = ({ payload }) => {
  const cfg = STATUS_CONFIG[payload.status] ?? STATUS_CONFIG.proposed!
  const dim = payload.status === 'superseded' || payload.status === 'kept'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={cfg.color} paddingX={1} marginY={1}>
      <Box>
        <Text bold color={cfg.color}>{cfg.icon} {cfg.label}</Text>
      </Box>
      <Box marginTop={0}>
        <Text dimColor={dim}>{payload.planMd.slice(0, PLAN_PREVIEW_CHARS)}{payload.planMd.length > PLAN_PREVIEW_CHARS ? '...' : ''}</Text>
      </Box>
    </Box>
  )
}

export const widgetPlanProposal: WidgetDescriptor<PlanProposalPayload> = {
  name: 'plan.proposal',
  Component: WidgetPlanProposal,
}
