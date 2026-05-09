import type { ReviewConfig } from './types';
import type { Provider } from '../types';
import { forkReviewAgent } from './review-agent';
import { EffectivenessTracker } from './effectiveness-tracker';
import { forkSkillAnalysis, buildAnalysisPrompt, verdictToEvalCase, type TraceSnippet } from './skill-analyzer';
import type { TraceRun, TraceSummary, TraceStore } from '../trace/types';
import { debugLog } from '../utils/debug';
import os from 'os';
import path from 'path';

const DEFAULT_AUTO_ACCEPT_HOURS = 48;
const DEFAULT_REVIEW_INTERVAL = 10;
const FEEDBACK_CASES_NOTIFY_THRESHOLD = 5;
const REASONING_PREVIEW_LENGTH = 80;
const TIER2_RECENT_SESSION_LIMIT = 5;
const TIER2_RECENT_RUN_LIMIT = 3;

export interface EvolutionModule {
  review: (
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ) => void;
  trackStats: (summary: TraceSummary, runId: string) => Promise<Array<{ skillName: string; triggerReview: boolean }>>;
  autoAcceptStaleSkills: () => Promise<string[]>;
  runTier2Analysis: (skillName: string, description: string) => void;
  outputDir: string;
}

type TriggerType = 'error_burst' | 'complex_task' | 'periodic';

function isValidTrigger(value: string): value is TriggerType {
  return value === 'error_burst' || value === 'complex_task' || value === 'periodic';
}

export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
  notify?: (skillName: string, description: string, outputDir: string) => void,
  store?: TraceStore,
  reviewInterval?: number,
): EvolutionModule | null {
  if (!config.enabled) return null;

  const outputDir = config.outputDir.startsWith('~')
    ? path.join(os.homedir(), config.outputDir.slice(1))
    : config.outputDir;

  let isReviewRunning = false;
  let feedbackCasesPending = 0;
  const tracker = new EffectivenessTracker(outputDir);
  const effectiveReviewInterval = reviewInterval ?? DEFAULT_REVIEW_INTERVAL;

  return {
    outputDir,
    review(nudgeResult, trace) {
      // Concurrency guard: one review at a time
      if (isReviewRunning) {
        debugLog('[evolution] Review skipped — another review is already running');
        return;
      }

      const signal = nudgeResult.signal;
      if (!isValidTrigger(signal)) {
        debugLog(`[evolution] Unknown signal: ${signal}`);
        return;
      }

      isReviewRunning = true;

      forkReviewAgent(signal, trace, {
        outputDir,
        provider,
        model: config.model,
        maxTurns: config.maxTurns,
        tokenLimit: config.tokenLimit,
        timeoutMs: config.timeoutMs,
        onSkillCreated: notify,
        onComplete: () => {
          isReviewRunning = false;
        },
        ...(store ? { store } : {}),
        ...(effectiveReviewInterval ? { reviewInterval: effectiveReviewInterval } : {}),
      });
    },
    async trackStats(summary, runId) {
      const results: Array<{ skillName: string; triggerReview: boolean }> = [];
      if (!summary.activatedSkills || summary.activatedSkills.length === 0) {
        return results;
      }
      for (const skillName of summary.activatedSkills) {
        try {
          const stats = await tracker.updateStats(skillName, summary.outcome, runId);
          const triggerReview = tracker.shouldTriggerReview(stats);
          results.push({ skillName, triggerReview });
          if (triggerReview) {
            debugLog(`[evolution] Low score for ${skillName}: ${stats.successRate.toFixed(2)} (${stats.successfulRuns}/${stats.totalRuns}) — Tier 2 review recommended`);
          }
        } catch (err) {
          debugLog(`[evolution] Failed to update stats for ${skillName}: ${err}`);
        }
      }
      return results;
    },
    autoAcceptStaleSkills: () => tracker.autoAcceptStaleSkills(config.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS),

    runTier2Analysis(skillName, description) {
      void (async () => {
        const status = await tracker.loadStatus(skillName);
        const stats = status?.stats ?? { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' };

        let traces: TraceSnippet[] = [];
        if (store) {
          try {
            const recentRuns = await store.listRecent(TIER2_RECENT_SESSION_LIMIT, TIER2_RECENT_RUN_LIMIT);
            traces = recentRuns
              .filter(r => r.summary.activatedSkills?.includes(skillName))
              .map(r => ({
                outcome: r.summary.outcome,
                traces: `Turns: ${r.summary.totalTurns}, Errors: ${r.summary.totalErrors}, ` +
                  r.turns.map((t, i) => `Turn ${i}: ${t.toolExecutions.map(e => `${e.toolName}(${e.success ? 'ok' : 'fail'})`).join(', ')}`).join(' | '),
              }));
          } catch {
            /* best-effort */
          }
        }

        const prompt = buildAnalysisPrompt(skillName, description, stats, traces);
        forkSkillAnalysis(prompt, provider, config.model, (verdict) => { void (async () => {
          if (verdict) {
            const currentStatus = await tracker.loadStatus(skillName);
            if (currentStatus) {
              currentStatus.status = 'reviewed';
              await tracker.saveStatus(currentStatus);
            }

            if (verdict.verdict === 'fix') {
              notify?.(skillName, `Analysis: skill needs adjustment — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review view ${skillName}]`, outputDir);
            } else if (verdict.verdict === 'delete') {
              notify?.(skillName, `Marked as harmful — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review delete ${skillName}]`, outputDir);
            }

            const evalCase = verdictToEvalCase(skillName, verdict);
            if (evalCase) {
              try {
                await tracker.appendFeedbackEval(skillName, JSON.stringify(verdict));
                feedbackCasesPending++;
                if (feedbackCasesPending >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
                  debugLog(`[evolution] ${feedbackCasesPending} feedback cases pending for prompt optimization`);
                  notify?.('prompt-optimization', `${feedbackCasesPending} feedback cases pending — run /review optimize to improve review prompts`, outputDir);
                }
              } catch (err) {
                debugLog(`[evolution] Failed to append feedback: ${err}`);
              }
            }
          }
        })(); });
      })();
    },
  };
}

// Re-export for consumers
export { CreateReviewSkillTool } from './review-tools';
export { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
export { EffectivenessTracker } from './effectiveness-tracker';
export type { ReviewConfig, ReviewNotification, EvolutionCallback, SkillStats, SkillStatus } from './types';
