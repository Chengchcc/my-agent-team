import type { SkillStatsSnapshot } from './stats-collector'

export interface AutoRetireConfig {
  enabled: boolean
  minSampleSize: number
  windowSize: number
  retireThreshold: number
}

export type RetireDecision =
  | { action: 'healthy' }
  | { action: 'retire'; reason: string }

/**
 * Pure function implementing 2-stage decision ladder:
 *   1. recentRuns < minSampleSize → healthy (insufficient data)
 *   2. successRate < retireThreshold → retire
 *   3. Otherwise → healthy
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

  const denom = s.recentRuns || 1
  const successRate = s.recentSuccess / denom

  if (successRate < cfg.retireThreshold) {
    return {
      action: 'retire',
      reason: `Success rate ${(successRate * 100).toFixed(0)}% is below retire threshold ${(cfg.retireThreshold * 100).toFixed(0)}% (${s.recentSuccess}/${s.recentRuns} recent successes, ${s.recentFail} failures, ${s.recentCancel} cancels)`,
    }
  }

  return { action: 'healthy' }
}
