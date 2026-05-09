import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind } from './persistent-queue';
import type { Drainer } from './drainer';
import type { SettleBus } from './settle-bus';
import type { IdleGate } from './idle-gate';

type DrainFn = (opts?: { force?: boolean; allowedKinds?: EvolutionTaskKind[] }) => Promise<number>;

const IDLE_WINDOW_MS = 30 * 1000;
const EVENT_DELAY_MS = 1000;

// ── Trigger type ──

export interface Trigger {
  start(): void;
  stop(): void;
}

// ── IdleTrigger ──

const IDLE_TRIGGER_KINDS: EvolutionTaskKind[] = ['tier0_review', 'tier2_verdict'];

export function createIdleTrigger(
  idleGate: IdleGate,
  drain: DrainFn,
): Trigger {
  let timer: ReturnType<typeof setInterval> | null = null;
  let idleSince = 0;

  return {
    start() {
      timer = setInterval(() => {
        if (idleGate.canRun()) {
          if (idleSince === 0) idleSince = Date.now();
          if (Date.now() - idleSince >= IDLE_WINDOW_MS) {
            idleSince = Date.now();
            void drain({ allowedKinds: IDLE_TRIGGER_KINDS });
          }
        } else {
          idleSince = 0;
        }
      }, IDLE_WINDOW_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

// ── EventTrigger ──

const EVENT_TRIGGER_KINDS: EvolutionTaskKind[] = ['tier0_review'];

export function createEventTrigger(
  bus: SettleBus,
  drain: DrainFn,
): Trigger {
  const unsub = bus.on((event) => {
    if (event.kind === 'main_loop_settled') {
      setTimeout(() => { void drain({ allowedKinds: EVENT_TRIGGER_KINDS }); }, EVENT_DELAY_MS);
    }
  });

  return {
    start() {},
    stop() { unsub(); },
  };
}

// ── CronTrigger ──

type CronEntry = { schedule: string; kinds: EvolutionTaskKind[]; timer: ReturnType<typeof setInterval> | null };

const CRON_MINUTE_MS = 15 * 60 * 1000;
const CRON_DAILY_MS = 24 * 3600 * 1000;
const CRON_WEEKLY_MS = 7 * 24 * 3600 * 1000;

export function createCronTriggers(drain: DrainFn): Trigger[] {
  const entries: CronEntry[] = [
    { schedule: '*/15min', kinds: ['tier0_review', 'tier2_verdict'], timer: null },
    { schedule: 'daily 03:00', kinds: ['tier3_ab_promote', 'auto_accept_sweep'], timer: null },
    { schedule: 'weekly Sun 04:00', kinds: ['tier3_prompt_opt'], timer: null },
  ];

  return entries.map(entry => ({
    start() {
      const interval = entry.schedule.startsWith('*/15') ? CRON_MINUTE_MS
        : entry.schedule.startsWith('daily') ? CRON_DAILY_MS : CRON_WEEKLY_MS;
      entry.timer = setInterval(() => {
        debugLog(`[cron] Firing ${entry.schedule} — kinds: ${entry.kinds.join(',')}`);
        void drain({ allowedKinds: entry.kinds });
      }, interval);
    },
    stop() { if (entry.timer) { clearInterval(entry.timer); entry.timer = null; } },
  }));
}

// ── ThresholdTrigger ──

const THRESHOLD_PER_KIND = 10;

export function createThresholdTrigger(drain: DrainFn): Trigger {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Simple polling approach — PersistentQueue doesn't expose per-kind size yet.
  // For now, threshold trigger is a stub that drains everything every 5 minutes.
  return {
    start() {
      timer = setInterval(() => {
        debugLog('[threshold] Checking queue thresholds');
        void drain({ allowedKinds: ['tier0_review', 'tier2_verdict', 'tier3_prompt_opt'] });
      }, 5 * 60 * 1000);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

// ── ManualTrigger ──

export function createManualTrigger(drain: DrainFn): { fire: (kinds?: EvolutionTaskKind[]) => void } {
  return {
    fire(kinds) {
      debugLog(`[manual] Firing drain — kinds: ${kinds?.join(',') ?? 'all'}`);
      void drain({ force: true, allowedKinds: kinds });
    },
  };
}

// ── Trigger orchestrator ──

export function startAllTriggers(
  idleGate: IdleGate,
  bus: SettleBus,
  drain: DrainFn,
): { manual: ReturnType<typeof createManualTrigger>; stop: () => void } {
  const triggers: Trigger[] = [
    createIdleTrigger(idleGate, drain),
    createEventTrigger(bus, drain),
    ...createCronTriggers(drain),
    createThresholdTrigger(drain),
  ];

  for (const t of triggers) t.start();

  const manual = createManualTrigger(drain);

  return {
    manual,
    stop() { for (const t of triggers) t.stop(); },
  };
}
