import type { ReviewConfig } from './types';
import type { Provider } from '../types';
import { forkReviewAgent } from './review-agent';
import { EffectivenessTracker } from './effectiveness-tracker';
import { forkSkillAnalysis, buildAnalysisPrompt, verdictToEvalCase, type TraceSnippet } from './skill-analyzer';
import type { TraceRun, TraceSummary, TraceStore } from '../trace/types';
import { debugLog } from '../utils/debug';
import { IdleGate } from './idle-gate';
import { ReviewSlot, signalPriority } from './review-slot';
import { CircuitBreaker } from './circuit-breaker';
import { ReviewBackoff } from './review-backoff';
import { TaskRunner } from './review-runner';
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
  idleGate: IdleGate;
}

type TriggerType = 'error_burst' | 'complex_task' | 'periodic';

function isValidTrigger(value: string): value is TriggerType {
  return value === 'error_burst' || value === 'complex_task' || value === 'periodic';
}

function createTier2Handler(
  tracker: EffectivenessTracker,
  store: TraceStore | undefined,
  provider: Provider,
  model: string,
  notify: ((skillName: string, description: string, outputDir: string) => void) | undefined,
  outputDir: string,
  feedbackCases: { value: number },
) {
  return (skillName: string, description: string) => {
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
        } catch { /* best-effort */ }
      }

      const prompt = buildAnalysisPrompt(skillName, description, stats, traces);
      forkSkillAnalysis(prompt, provider, model, (verdict) => { void (async () => {
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
              feedbackCases.value++;
              if (feedbackCases.value >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
                debugLog(`[evolution] ${feedbackCases.value} feedback cases pending for prompt optimization`);
                notify?.('prompt-optimization', `${feedbackCases.value} feedback cases pending — run /review optimize to improve review prompts`, outputDir);
              }
            } catch (err) {
              debugLog(`[evolution] Failed to append feedback: ${err}`);
            }
          }
        }
      })(); });
    })();
  };
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

  const feedbackCases = { value: 0 };
  const tracker = new EffectivenessTracker(outputDir);
  const effectiveReviewInterval = reviewInterval ?? DEFAULT_REVIEW_INTERVAL;
  const idleGate = new IdleGate();
  const slot = new ReviewSlot();
  const breaker = new CircuitBreaker();
  const backoff = new ReviewBackoff();
  const runner = new TaskRunner();

  return {
    outputDir,
    review(nudgeResult, trace) {
      const signal = nudgeResult.signal;
      if (!isValidTrigger(signal)) {
        debugLog(`[evolution] Unknown signal: ${signal}`);
        return;
      }

      if (!breaker.canRun()) {
        debugLog('[evolution] Review skipped — CircuitBreaker is open');
        return;
      }
      if (!backoff.canRun()) {
        debugLog('[evolution] Review skipped — backoff delay active');
        return;
      }
      if (!idleGate.canRun()) {
        slot.tryEnqueue({ signal, priority: signalPriority(signal), nudgeResult, trace });
        debugLog(`[evolution] Queued ${signal} review for later (system busy)`);
        return;
      }
      if (slot.running) {
        const task = { signal, priority: signalPriority(signal), nudgeResult, trace };
        if (slot.tryEnqueue(task)) {
          debugLog('[evolution] Queued review (higher priority)');
        } else {
          debugLog('[evolution] Review skipped — lower priority than pending');
        }
        return;
      }

      slot.tryEnqueue({ signal, priority: signalPriority(signal), nudgeResult, trace });
      slot.markRunning();

      runner.run(
        () => new Promise<void>((resolve, reject) => {
          forkReviewAgent(signal, trace, {
            outputDir,
            provider,
            model: config.model,
            maxTurns: config.maxTurns,
            tokenLimit: config.tokenLimit,
            timeoutMs: config.timeoutMs,
            onSkillCreated: notify,
            onComplete: resolve,
            onError: reject,
            ...(store ? { store } : {}),
            ...(effectiveReviewInterval ? { reviewInterval: effectiveReviewInterval } : {}),
          });
        }),
        {
          onComplete: () => {
            slot.markDone();
            backoff.recordSuccess();
            breaker.recordSuccess();
          },
          onError: () => {
            backoff.recordFailure();
            breaker.recordFailure();
          },
        },
      );
    },
    idleGate,
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

    runTier2Analysis: createTier2Handler(
      tracker, store, provider, config.model, notify, outputDir,
      feedbackCases,
    ),
  };
}

// Re-export for consumers
export { CreateReviewSkillTool } from './review-tools';
export { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
export { EffectivenessTracker } from './effectiveness-tracker';
export { IdleGate } from './idle-gate';
export { ReviewSlot, signalPriority } from './review-slot';
export type { PendingReview } from './review-slot';
export { CircuitBreaker } from './circuit-breaker';
export { ReviewBackoff } from './review-backoff';
export { TaskRunner } from './review-runner';
export type { RunnerContext } from './review-runner';
export type { ReviewConfig, ReviewNotification, EvolutionCallback, SkillStats, SkillStatus } from './types';
