import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind } from './persistent-queue';
import { CircuitBreaker } from './circuit-breaker';

const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const HOUR_MS = SECONDS_PER_HOUR * MS_PER_SECOND;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const DAYS_PER_WEEK = 7;
const WEEK_MS = DAYS_PER_WEEK * DAY_MS;

const MEM_EXTRACT_COOLDOWN_MINUTES = 30;
const MEM_EMBED_COOLDOWN_MINUTES = 15;

const THRESHOLDS: Record<EvolutionTaskKind, number> = {
  tier0_review: 3,
  tier2_verdict: 3,
  tier3_prompt_opt: 2,
  tier3_ab_promote: 2,
  auto_accept_sweep: 2,
  'mem-extract': 3,
  'mem-embed': 5,
};

const TIER2_COOLDOWN_MINUTES = 30;
const COOLDOWNS: Record<EvolutionTaskKind, number> = {
  tier0_review: HOUR_MS,
  tier2_verdict: TIER2_COOLDOWN_MINUTES * MINUTE_MS,
  tier3_prompt_opt: WEEK_MS,
  tier3_ab_promote: DAY_MS,
  auto_accept_sweep: DAY_MS,
  'mem-extract': MEM_EXTRACT_COOLDOWN_MINUTES * MINUTE_MS,
  'mem-embed': MEM_EMBED_COOLDOWN_MINUTES * MINUTE_MS,
};

export class TierBreaker {
  private breakers = new Map<EvolutionTaskKind, CircuitBreaker>();

  constructor() {
    for (const kind of Object.keys(THRESHOLDS) as EvolutionTaskKind[]) {
      this.breakers.set(kind, new CircuitBreaker(undefined, COOLDOWNS[kind], THRESHOLDS[kind]));
    }
  }

  canRun(kind: EvolutionTaskKind): boolean {
    return this.breakers.get(kind)?.canRun() ?? true;
  }

  recordSuccess(kind: EvolutionTaskKind): void {
    this.breakers.get(kind)?.recordSuccess();
  }

  recordFailure(kind: EvolutionTaskKind): void {
    const b = this.breakers.get(kind);
    b?.recordFailure();
    if (b && !b.canRun()) {
      debugLog(`[TierBreaker] ${kind} circuit OPEN — ${THRESHOLDS[kind]} failures, cooldown ${COOLDOWNS[kind] / MS_PER_SECOND}s`);
    }
  }

  isOpen(kind: EvolutionTaskKind): boolean {
    return !this.canRun(kind);
  }
}
