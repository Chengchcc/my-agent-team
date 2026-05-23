import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'

const MIN_TURNS_BETWEEN_REVIEWS = 10
const ERROR_BURST_THRESHOLD = 3
const ERROR_BURST_WINDOW_MINUTES = 5
const MS_PER_MINUTE = 60_000
const ERROR_BURST_WINDOW_MS = ERROR_BURST_WINDOW_MINUTES * MS_PER_MINUTE
const SKILL_REVIEW_INTERVAL_RUNS = 20

export type Decision =
  | { kind: 'skip' }
  | { kind: 'tier0' }
  | { kind: 'tier2'; skillName: string }

export interface PolicyState {
  turnsSinceReview: number
  errorBurst: number[]
  skillRunsSeen: Record<string, number>
}

export function evaluateReviewPolicy(
  event: TurnCompletedV1 | TurnFailedV1,
  s: PolicyState,
): Decision {
  s.turnsSinceReview++

  if ('outcome' in event && event.outcome !== ('completed' as never)) {
    s.errorBurst.push(Date.now())
    s.errorBurst = s.errorBurst.filter(t => Date.now() - t < ERROR_BURST_WINDOW_MS)
    if (s.errorBurst.length >= ERROR_BURST_THRESHOLD) {
      s.errorBurst = []
      s.turnsSinceReview = 0
      return { kind: 'tier0' }
    }
    return { kind: 'skip' }
  }

  const completed = event as TurnCompletedV1
  for (const skill of completed.activatedSkills ?? []) {
    s.skillRunsSeen[skill] = (s.skillRunsSeen[skill] ?? 0) + 1
    if (s.skillRunsSeen[skill] >= SKILL_REVIEW_INTERVAL_RUNS) {
      s.skillRunsSeen[skill] = 0
      return { kind: 'tier2', skillName: skill }
    }
  }

  if (s.turnsSinceReview >= MIN_TURNS_BETWEEN_REVIEWS) {
    s.turnsSinceReview = 0
    return { kind: 'tier0' }
  }

  return { kind: 'skip' }
}
