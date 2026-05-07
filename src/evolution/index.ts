import type { ReviewConfig } from './types';
import type { Provider } from '../types';
import { forkReviewAgent } from './review-agent';
import { EffectivenessTracker } from './effectiveness-tracker';
import { forkSkillAnalysis, buildAnalysisPrompt, verdictToEvalCase } from './skill-analyzer';
import type { TraceRun, TraceSummary } from '../trace/types';
import { debugLog } from '../utils/debug';
import os from 'os';
import path from 'path';

const DEFAULT_AUTO_ACCEPT_HOURS = 48;
const FEEDBACK_CASES_NOTIFY_THRESHOLD = 5;

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
  onSkillCreated?: ((skillName: string, description: string, outputDir: string) => void) | undefined,
): EvolutionModule | null {
  if (!config.enabled) return null;

  const outputDir = config.outputDir.startsWith('~')
    ? path.join(os.homedir(), config.outputDir.slice(1))
    : config.outputDir;

  let isReviewRunning = false;
  let feedbackCasesPending = 0;
  const tracker = new EffectivenessTracker(outputDir);

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
        onSkillCreated,
        onComplete: () => {
          isReviewRunning = false;
        },
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
      const stats = { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' };
      const prompt = buildAnalysisPrompt(skillName, description, stats, []);

      forkSkillAnalysis(prompt, provider, config.model, (verdict) => { void (async () => {
        if (verdict) {
          // Update status with analysis
          const status = await tracker.loadStatus(skillName);
          if (status) {
            status.status = 'reviewed';
            await tracker.saveStatus(status);
          }

          // Append feedback eval case
          const evalCase = verdictToEvalCase(skillName, verdict);
          if (evalCase) {
            try {
              await tracker.appendFeedbackEval(skillName, JSON.stringify(verdict));
              feedbackCasesPending++;
              if (feedbackCasesPending >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
                debugLog(`[evolution] ${feedbackCasesPending} feedback cases pending for prompt optimization`);
              }
            } catch (err) {
              debugLog(`[evolution] Failed to append feedback: ${err}`);
            }
          }
        }
      })(); });
    },
  };
}

// Re-export for consumers
export { CreateReviewSkillTool } from './review-tools';
export { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
export { EffectivenessTracker } from './effectiveness-tracker';
export type { ReviewConfig, ReviewNotification, EvolutionCallback, SkillStats, SkillStatus } from './types';
