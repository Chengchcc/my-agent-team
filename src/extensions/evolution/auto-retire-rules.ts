import type { SkillStatsSnapshot } from './stats-collector'

const MS_PER_DAY = 86_400_000

export interface AutoRetireConfig {
  enabled: boolean
  minSampleSize: number
  windowSize: number
  healthThreshold: number
  flagThreshold: number
  retireThreshold: number
  flagGracePeriodMs: number
  cancelCountsAsFailure: boolean
}

export type RetireDecision =
  | { action: 'healthy' }
  | { action: 'unflag' }
  | { action: 'flag'; reason: string }
  | { action: 'retire'; reason: string }

/**
 * Pure function implementing the decision ladder from spec Section 3.
 *
 * Steps:
 *   1. recentRuns < minSampleSize → healthy (insufficient data)
 *   2. successRate >= healthThreshold → healthy (and unflag if flagged)
 *   3. successRate < flagThreshold AND not flagged → flag
 *   4. successRate < retireThreshold OR (flagged AND grace period expired) → retire
 *   5. Otherwise → healthy
 */
export function evaluateRetireRules(
  s: SkillStatsSnapshot,
  cfg: AutoRetireConfig,
): RetireDecision {
  if (!cfg.enabled) {
    return { action: 'healthy' }
  }

  if (s.recentRuns < cfg.minSampleSize) {
    return { action: 'healthy' }
  }

  const effectiveFailures = cfg.cancelCountsAsFailure
    ? s.recentFail + s.recentCancel
    : s.recentFail

  const effectiveSuccess = cfg.cancelCountsAsFailure
    ? s.recentSuccess
    : s.recentRuns - effectiveFailures

  const denom = s.recentRuns || 1
  const successRate = effectiveSuccess / denom

  // Step 2: healthy threshold — if flagged, also unflag
  if (successRate >= cfg.healthThreshold) {
    if (s.flagged) {
      return { action: 'unflag' }
    }
    return { action: 'healthy' }
  }

  // Step 3: flag threshold
  if (successRate < cfg.flagThreshold && !s.flagged) {
    return {
      action: 'flag',
      reason: `Success rate ${(successRate * 100).toFixed(0)}% is below flag threshold ${(cfg.flagThreshold * 100).toFixed(0)}% (${s.recentSuccess}/${s.recentRuns} recent successes, ${s.recentFail} failures, ${s.recentCancel} cancels)`,
    }
  }

  // Step 4: retire threshold or flagged + grace expired
  if (successRate < cfg.retireThreshold) {
    return {
      action: 'retire',
      reason: `Success rate ${(successRate * 100).toFixed(0)}% is below retire threshold ${(cfg.retireThreshold * 100).toFixed(0)}% (${s.recentSuccess}/${s.recentRuns} recent successes, ${s.recentFail} failures, ${s.recentCancel} cancels)`,
    }
  }

  if (
    s.flagged &&
    s.flaggedAt !== undefined &&
    cfg.flagGracePeriodMs > 0
  ) {
    const elapsed = Date.now() - s.flaggedAt
    if (elapsed >= cfg.flagGracePeriodMs) {
      return {
        action: 'retire',
        reason: `Flagged for ${Math.round(elapsed / MS_PER_DAY)} days; grace period (${Math.round(cfg.flagGracePeriodMs / MS_PER_DAY)} days) expired with success rate ${(successRate * 100).toFixed(0)}%`,
      }
    }
  }

  // Step 5: default — healthy
  return { action: 'healthy' }
}
