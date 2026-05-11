import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind, TaskPayload } from './persistent-queue';
import type { PersistentQueue } from './persistent-queue';
import type { TraceRun } from '../trace/types';

type DrainFn = (opts?: { force?: boolean; allowedKinds?: EvolutionTaskKind[] }) => Promise<number>;

interface CronSchedule {
  nextFire(from: Date): Date;
  expression: string;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const CRON_FIELD_COUNT = 5;
const LONG_CYCLE_MINUTES = 40;
const LONG_CYCLE_THRESHOLD_MS = LONG_CYCLE_MINUTES * MS_PER_MINUTE;
const FP_HOUR_SLICE = 13;

// ── Parser ──

function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) throw new Error(`Invalid cron: ${expr}`);

  const [minStr, hourStr, , , dow] = fields as [string, string, string, string, string];

  // Minute
  let minutePattern: 'every-n' | 'exact';
  let minuteValue = 0;
  if (minStr.startsWith('*/')) {
    minutePattern = 'every-n';
    minuteValue = parseInt(minStr.slice(2), 10);
  } else {
    minutePattern = 'exact';
    minuteValue = parseInt(minStr, 10);
  }

  // Hour
  const hourExact = hourStr !== '*' ? parseInt(hourStr, 10) : undefined;

  // Day of week
  const dowExact = dow !== '*' ? parseInt(dow, 10) : undefined;

  return {
    expression: expr,
    nextFire(from: Date): Date {
      const d = new Date(from);
      d.setMilliseconds(0);
      d.setSeconds(0);

      if (minutePattern === 'every-n') {
        // Step to next interval boundary
        const next = Math.ceil(d.getMinutes() / minuteValue) * minuteValue;
        if (next >= SECONDS_PER_MINUTE) {
          d.setHours(d.getHours() + 1);
          d.setMinutes(0);
        } else {
          d.setMinutes(next);
        }
        // If we landed on or before from, add one interval
        if (d.getTime() <= from.getTime()) {
          d.setMinutes(d.getMinutes() + minuteValue);
        }
        return d;
      }

      // Exact minute + optional hour + optional DOW
      d.setMinutes(minuteValue);

      if (hourExact !== undefined) {
        d.setHours(hourExact);
      }
      if (d.getTime() <= from.getTime()) {
        if (dowExact !== undefined) {
          // Next matching day of week
          do {
            d.setDate(d.getDate() + 1);
          } while (d.getDay() !== dowExact);
          d.setHours(hourExact ?? 0);
          d.setMinutes(minuteValue);
        } else {
          // Next day
          d.setDate(d.getDate() + 1);
        }
      }

      // If DOW specified and current day doesn't match, advance
      if (dowExact !== undefined && d.getDay() !== dowExact) {
        while (d.getDay() !== dowExact) {
          d.setDate(d.getDate() + 1);
        }
        d.setHours(hourExact ?? 0);
        d.setMinutes(minuteValue);
      }

      return d;
    },
  };
}

// ── Trigger factory ──

export function createCronTrigger(
  expr: string,
  kinds: EvolutionTaskKind[],
  drain: DrainFn,
  queue?: PersistentQueue,
): { start(): void; stop(): void } {
  const schedule = parseCron(expr);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;
    const next = schedule.nextFire(new Date());
    const delay = Math.max(0, next.getTime() - Date.now());

    if (delay > LONG_CYCLE_THRESHOLD_MS && queue) {
      // Long cycle: enqueue to PersistentQueue with nextRunAt, then re-schedule
      const fp = `cron:${expr}:${next.toISOString().slice(0, FP_HOUR_SLICE)}`;
      queue.enqueue({
        kind: kinds[0]!,
        priority: 'normal',
        fingerprint: fp,
        scheduledBy: 'cron',
        payload: cronPayload(kinds[0]!),
      }).then(() => {
        debugLog(`[cron] Enqueued ${expr} for ${next.toISOString()} (kinds: ${kinds.join(',')})`);
      }).catch(() => {});
      // Re-schedule for next occurrence
      timer = setTimeout(() => { scheduleNext(); }, delay);
    } else {
      // Short cycle: in-process setTimeout
      debugLog(`[cron] Scheduling ${expr} in ${Math.round(delay / MS_PER_SECOND)}s`);
      timer = setTimeout(() => {
        void drain({ allowedKinds: kinds });
        scheduleNext();
      }, delay);
    }
  }

  return {
    start() {
      stopped = false;
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

function cronPayload(kind: EvolutionTaskKind): TaskPayload {
  switch (kind) {
    case 'tier0_review': return { kind: 'tier0_review', sessionId: '', runId: '', signal: 'periodic', trace: {} as TraceRun };
    case 'tier2_verdict': return { kind: 'tier2_verdict', skillName: '', description: '', skillStats: { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' }, traceRunId: '' };
    case 'tier3_prompt_opt': return { kind: 'tier3_prompt_opt', promptKey: 'review', feedbackWindow: { from: 0, to: Date.now() } };
    case 'tier3_ab_promote': return { kind: 'tier3_ab_promote', candidateId: '', shadowStartedAt: 0 };
    case 'auto_accept_sweep': return { kind: 'auto_accept_sweep', cutoff: Date.now() };
    case 'mem-extract': return { kind: 'mem-extract', traceId: '', projectPath: '' };
    case 'mem-embed': return { kind: 'mem-embed', entryId: '', text: '' };
  }
}
