/** Accumulated review statistics for a single skill. */
export interface SkillStats {
  name: string
  totalRuns: number
  successfulRuns: number
  lastRunId?: string
  lastReviewedAt: number  // unix ms
}

