import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { EvolutionProposalsPayload } from '../../../evolution/widget-payloads'

const REASONING_PREVIEW_CHARS = 80

const TIER_COLOR: Record<string, string> = {
  tier0: 'blue',
  tier2: 'magenta',
}

const OUTCOME_ICON: Record<string, string> = {
  accepted: '+',
  rejected: '-',
  inconclusive: '?',
}

const OUTCOME_COLOR: Record<string, string> = {
  accepted: 'green',
  rejected: 'red',
  inconclusive: 'yellow',
}

const WidgetEvolutionProposals: React.FC<{ payload: EvolutionProposalsPayload }> = ({ payload }) => {
  if (payload.proposals.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Evolution Proposals</Text>
        <Text color="gray"> ({payload.proposals.length})</Text>
      </Box>
      {payload.proposals.map((p, i) => {
        const tierColor = TIER_COLOR[p.tier] ?? 'gray'
        const icon = OUTCOME_ICON[p.outcome] ?? '?'
        const outcomeColor = OUTCOME_COLOR[p.outcome] ?? 'gray'
        const reason = p.reasoning.length > REASONING_PREVIEW_CHARS ? p.reasoning.slice(0, REASONING_PREVIEW_CHARS) + '...' : p.reasoning
        const date = new Date(p.createdAt).toISOString().slice(0, 10)
        return (
          <Box key={p.id} flexDirection="column" marginY={0}>
            <Box>
              <Text>
                <Text color="gray" dimColor>{i + 1}.</Text>{' '}
                <Text color={tierColor} bold>[{p.tier.toUpperCase()}]</Text>
                <Text color={outcomeColor}> {icon} {p.outcome}</Text>
                {p.skillName ? <Text color="cyan"> @{p.skillName}</Text> : null}
                <Text color="gray" dimColor> {date}</Text>
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="gray" dimColor>{reason}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export const widgetEvolutionProposals: WidgetDescriptor<EvolutionProposalsPayload> = {
  name: 'evolution.proposals',
  Component: WidgetEvolutionProposals,
}
