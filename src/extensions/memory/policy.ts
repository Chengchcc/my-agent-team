import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'

const MIN_TOKENS_TO_EXTRACT = 800
const FORCE_EXTRACT_INTERVAL = 5

export type Decision = { kind: 'skip' } | { kind: 'extract' }

export interface PolicyState {
  turnsSinceExtract: number
}

export function evaluateExtractPolicy(
  e: TurnCompletedV1 | TurnFailedV1,
  s: PolicyState,
): Decision {
  s.turnsSinceExtract++

  if ('outcome' in e && e.outcome !== ('completed' as never)) return { kind: 'skip' }

  const completed = e as TurnCompletedV1
  const tokens = (completed.usage?.input ?? 0) + (completed.usage?.output ?? 0)

  if (tokens >= MIN_TOKENS_TO_EXTRACT) {
    s.turnsSinceExtract = 0
    return { kind: 'extract' }
  }
  if (s.turnsSinceExtract >= FORCE_EXTRACT_INTERVAL) {
    s.turnsSinceExtract = 0
    return { kind: 'extract' }
  }
  return { kind: 'skip' }
}
