import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind, PersistentQueue } from './persistent-queue';
import type { SettleBus } from './settle-bus';
import type { IdleGate } from './idle-gate';
import { createCronTrigger } from './cron-scheduler';

type DrainFn = (opts?: { force?: boolean; allowedKinds?: EvolutionTaskKind[] }) => Promise<number>;

const IDLE_WINDOW_SECONDS = 30;
const EVENT_DELAY_SECONDS = 1;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const IDLE_WINDOW_MS = IDLE_WINDOW_SECONDS * MS_PER_SECOND;
const EVENT_DELAY_MS = EVENT_DELAY_SECONDS * MS_PER_SECOND;

// ── Trigger type ──

export interface Trigger {
  start(): void;
  stop(): void;
}

// ── IdleTrigger ──

const IDLE_TRIGGER_KINDS: EvolutionTaskKind[] = ['tier0_review', 'tier2_verdict', 'mem-embed'];

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

const EVENT_TRIGGER_KINDS: EvolutionTaskKind[] = ['tier0_review', 'mem-extract'];

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

// ── CronTrigger (CronScheduler-based) ──

export function createCronTriggers(drain: DrainFn, queue?: PersistentQueue): Trigger[] {
  const entries: { expr: string; kinds: EvolutionTaskKind[] }[] = [
    { expr: '*/15 * * * *', kinds: ['tier0_review', 'tier2_verdict'] },
    { expr: '0 3 * * *', kinds: ['tier3_ab_promote', 'auto_accept_sweep'] },
    { expr: '0 4 * * 0', kinds: ['tier3_prompt_opt'] },
  ];

  return entries.map(({ expr, kinds }) => createCronTrigger(expr, kinds, drain, queue));
}

// ── ThresholdTrigger ──

const THRESHOLD_POLL_MINUTES = 5;
const THRESHOLD_POLL_INTERVAL_MS = THRESHOLD_POLL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export function createThresholdTrigger(drain: DrainFn): Trigger {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Simple polling approach — PersistentQueue doesn't expose per-kind size yet.
  // For now, threshold trigger is a stub that drains everything every 5 minutes.
  return {
    start() {
      timer = setInterval(() => {
        debugLog('[threshold] Checking queue thresholds');
        void drain({ allowedKinds: ['tier0_review', 'tier2_verdict', 'tier3_prompt_opt'] });
      }, THRESHOLD_POLL_INTERVAL_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

// ── ManualTrigger ──

export function createManualTrigger(drain: DrainFn): { fire: (kinds?: EvolutionTaskKind[]) => void } {
  return {
    fire(kinds) {
      debugLog(`[manual] Firing drain — kinds: ${kinds?.join(',') ?? 'all'}`);
      void drain({ force: true, ...(kinds ? { allowedKinds: kinds } : {}) });
    },
  };
}

// ── Trigger orchestrator ──

export function startAllTriggers(
  idleGate: IdleGate,
  bus: SettleBus,
  drain: DrainFn,
  queue?: PersistentQueue,
): { manual: ReturnType<typeof createManualTrigger>; stop: () => void } {
  const triggers: Trigger[] = [
    createIdleTrigger(idleGate, drain),
    createEventTrigger(bus, drain),
    ...createCronTriggers(drain, queue),
    createThresholdTrigger(drain),
  ];

  for (const t of triggers) t.start();

  const manual = createManualTrigger(drain);

  return {
    manual,
    stop() { for (const t of triggers) t.stop(); },
  };
}
