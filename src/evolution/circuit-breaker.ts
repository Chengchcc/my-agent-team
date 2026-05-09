import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { debugLog } from '../utils/debug';

const DEFAULT_THRESHOLD = 3;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const DEFAULT_COOLDOWN_MS = SECONDS_PER_HOUR * MS_PER_SECOND;
const STATE_DIR = path.join(os.homedir(), '.my-agent', 'state');

type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  failures = 0;
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private readonly statePath: string;
  private readonly cooldownMs: number;
  private readonly threshold: number;

  constructor(statePath?: string, cooldownMs?: number, threshold?: number) {
    this.statePath = statePath ?? path.join(STATE_DIR, 'breaker.json');
    this.cooldownMs = cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.threshold = threshold ?? DEFAULT_THRESHOLD;
  }

  canRun(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        debugLog('[evolution] CircuitBreaker half-open — allowing probe attempt');
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    void this.persist();
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      debugLog(`[evolution] CircuitBreaker OPEN after ${this.failures} consecutive failures — pausing for ${this.cooldownMs / MS_PER_SECOND}s`);
    }
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify({
        state: this.state,
        failures: this.failures,
        openedAt: this.openedAt,
      }), 'utf-8');
    } catch {
      /* best-effort */
    }
  }
}
