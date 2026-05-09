import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { SkillStats, SkillStatus } from './types';
import type { TraceSummary } from '../trace/types';
import { debugLog } from '../utils/debug';

const LOW_SCORE_THRESHOLD = 0.5;
const MIN_RUNS_FOR_REVIEW = 3;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

const FEEDBACK_DIR = path.join(os.homedir(), '.my-agent', 'feedback');
const FEEDBACK_PATH = path.join(FEEDBACK_DIR, 'feedback-evals.json');

export class EffectivenessTracker {
  private baseDir: string;

  constructor(outputDir: string) {
    this.baseDir = outputDir.startsWith('~')
      ? path.join(os.homedir(), outputDir.slice(1))
      : outputDir;
  }

  private statusPath(skillName: string): string {
    return path.join(this.baseDir, `${skillName}.status.json`);
  }

  shouldTriggerReview(stats: SkillStats): boolean {
    return stats.totalRuns >= MIN_RUNS_FOR_REVIEW && stats.successRate < LOW_SCORE_THRESHOLD;
  }

  async saveStatus(status: SkillStatus): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.statusPath(status.skillName), JSON.stringify(status, null, 2), 'utf-8');
  }

  async loadStatus(skillName: string): Promise<SkillStatus | null> {
    try {
      const content = await fs.readFile(this.statusPath(skillName), 'utf-8');
      return JSON.parse(content) as SkillStatus;
    } catch {
      return null;
    }
  }

  async updateStats(
    skillName: string,
    traceOutcome: TraceSummary['outcome'],
    runId: string,
  ): Promise<SkillStats> {
    const status = await this.loadStatus(skillName);
    const prevStats = status?.stats ?? { totalRuns: 0, successfulRuns: 0, successRate: 1, lastRunId: '' };

    const isNeutral = traceOutcome === 'aborted' || traceOutcome === 'aborted_by_review' || traceOutcome === 'compacted_mid' || traceOutcome === 'cleared' || traceOutcome === 'network_error';
    const isSuccess = traceOutcome === 'completed';

    const newStats: SkillStats = {
      totalRuns: prevStats.totalRuns + (isNeutral ? 0 : 1),
      successfulRuns: prevStats.successfulRuns + (isSuccess ? 1 : 0),
      successRate: 0,
      lastRunId: runId,
    };
    newStats.successRate = newStats.totalRuns > 0
      ? newStats.successfulRuns / newStats.totalRuns
      : 1;

    await this.saveStatus({
      skillName,
      status: status?.status ?? 'pending',
      createdAt: status?.createdAt ?? Date.now(),
      sourceRunId: status?.sourceRunId ?? '',
      stats: newStats,
    });

    debugLog(`[evolution] Updated stats for ${skillName}: ${newStats.successRate.toFixed(2)} (${newStats.successfulRuns}/${newStats.totalRuns})`);
    return newStats;
  }

  async appendFeedbackEval(
    skillName: string,
    verdictRaw: string,
  ): Promise<void> {
    const { parseVerdict, verdictToEvalCase } = await import('./skill-analyzer');
    const verdict = parseVerdict(verdictRaw);
    if (!verdict || verdict.verdict !== 'fix') return;
    const evalCase = verdictToEvalCase(skillName, verdict);
    if (!evalCase) return;

    await fs.mkdir(FEEDBACK_DIR, { recursive: true });

    let existing: unknown[] = [];
    try {
      existing = JSON.parse(await fs.readFile(FEEDBACK_PATH, 'utf-8'));
    } catch { /* file doesn't exist yet */ }

    existing.push(evalCase);
    await fs.writeFile(FEEDBACK_PATH, JSON.stringify(existing, null, 2), 'utf-8');
    debugLog(`[evolution] Appended feedback eval case for ${skillName}`);
  }

  async autoAcceptStaleSkills(autoAcceptHours: number): Promise<string[]> {
    const hourInMs = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
    const cutoff = Date.now() - autoAcceptHours * hourInMs;
    const accepted: string[] = [];
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.status.json')) continue;
        const skillName = entry.name.replace('.status.json', '');
        const status = await this.loadStatus(skillName);
        if (status && status.status === 'pending' && status.createdAt < cutoff) {
          status.status = 'kept';
          await this.saveStatus(status);
          accepted.push(skillName);
        }
      }
    } catch {
      // directory doesn't exist yet
    }
    return accepted;
  }
}
