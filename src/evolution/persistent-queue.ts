import fs from 'fs/promises';
import { openSync, closeSync, type Dirent } from 'node:fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'node:crypto';
import { debugLog } from '../utils/debug';
import type { TraceRun, TraceSummary } from '../trace/types';
import type { SkillStats } from './types';

// ── Task Kind ──

export type EvolutionTaskKind =
  | 'tier0_review'
  | 'tier2_verdict'
  | 'tier3_prompt_opt'
  | 'tier3_ab_promote'
  | 'auto_accept_sweep'
  | 'mem-extract'
  | 'mem-embed';

export type TriggerSource = 'error_burst' | 'complex_task' | 'periodic' | 'memory_worthy' | 'cron' | 'threshold' | 'manual';

// ── Union Payload ──

export type TaskPayload =
  | { kind: 'tier0_review'; sessionId: string; runId: string; signal: string; trace: TraceRun; recentSummaries?: TraceSummary[] }
  | { kind: 'tier2_verdict'; skillName: string; description: string; skillStats: SkillStats; traceRunId: string }
  | { kind: 'tier3_prompt_opt'; promptKey: 'review' | 'analyzer'; feedbackWindow: { from: number; to: number } }
  | { kind: 'tier3_ab_promote'; candidateId: string; shadowStartedAt: number }
  | { kind: 'auto_accept_sweep'; cutoff: number }
  | { kind: 'mem-extract'; traceId: string; projectPath: string }
  | { kind: 'mem-embed'; entryId: string; text: string };

export type QueuePriority = 'critical' | 'high' | 'normal' | 'low';

export interface EvolutionTask {
  id: string;
  kind: EvolutionTaskKind;
  priority: QueuePriority;
  payload: TaskPayload;
  attempt: number;
  maxAttempts: number;
  nextRunAt: number;
  enqueuedAt: number;
  fingerprint: string;
  scheduledBy: TriggerSource;
  parentTaskId?: string;
  lastError?: { msg: string; at: number };
}

// ── Per-Tier Parameters ──

const HEARTBEAT_SECONDS = 30;
const MS_PER_SECOND = 1000;
const HEARTBEAT_MS = HEARTBEAT_SECONDS * MS_PER_SECOND;
const ZOMBIE_MINUTES = 10;
const SECONDS_PER_MINUTE = 60;
const ZOMBIE_MS = ZOMBIE_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const JITTER = 0.2;
const ID_RADIX = 36;
const ID_BYTES = 4;
const LOCK_SUFFIX = '.json.lock';
const SECONDS_PER_HOUR = 3600;

interface TierParams {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const BACKOFF_TIER0_SECONDS = 30;
const BACKOFF_TIER0_HOURS = 6;
const BACKOFF_TIER2_MINUTES = 1;
const BACKOFF_TIER2_HOURS = 1;
const BACKOFF_TIER3_MINUTES = 10;
const BACKOFF_TIER3_HOURS = 24;
const BACKOFF_MEM_EXTRACT_SECONDS = 60;
const BACKOFF_MEM_EXTRACT_HOURS = 2;
const BACKOFF_MEM_EMBED_SECONDS = 30;
const BACKOFF_MEM_EMBED_HOURS = 1;

const TIER_PARAMS: Record<EvolutionTaskKind, TierParams> = {
  tier0_review: { maxAttempts: 5, backoffBaseMs: BACKOFF_TIER0_SECONDS * MS_PER_SECOND, backoffMaxMs: BACKOFF_TIER0_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND },
  tier2_verdict: { maxAttempts: 3, backoffBaseMs: BACKOFF_TIER2_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND, backoffMaxMs: BACKOFF_TIER2_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND },
  tier3_prompt_opt: { maxAttempts: 2, backoffBaseMs: BACKOFF_TIER3_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND, backoffMaxMs: BACKOFF_TIER3_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND },
  tier3_ab_promote: { maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0 },
  auto_accept_sweep: { maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0 },
  'mem-extract': { maxAttempts: 3, backoffBaseMs: BACKOFF_MEM_EXTRACT_SECONDS * MS_PER_SECOND, backoffMaxMs: BACKOFF_MEM_EXTRACT_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND },
  'mem-embed': { maxAttempts: 5, backoffBaseMs: BACKOFF_MEM_EMBED_SECONDS * MS_PER_SECOND, backoffMaxMs: BACKOFF_MEM_EMBED_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND },
};

const KIND_DIR: Record<EvolutionTaskKind, string> = {
  tier0_review: 'tier0',
  tier2_verdict: 'tier2',
  tier3_prompt_opt: 'tier3',
  tier3_ab_promote: 'tier3',
  auto_accept_sweep: 'housekeeping',
  'mem-extract': 'mem-extract',
  'mem-embed': 'mem-embed',
};

const EVO_DIR = 'evolution';
const QUEUE_DIR = 'queue';
const INFLIGHT_DIR = 'inflight';
const DEAD_DIR = 'dead';

// ── Helpers ──

function genId(): string {
  return `${Date.now().toString(ID_RADIX)}-${randomBytes(ID_BYTES).toString('hex')}`;
}

function nextDelay(kind: EvolutionTaskKind, attempt: number): number {
  const p = TIER_PARAMS[kind];
  if (p.backoffBaseMs === 0) return 0;
  const raw = Math.min(p.backoffBaseMs * Math.pow(2, attempt), p.backoffMaxMs);
  const jit = raw * JITTER * (2 * Math.random() - 1);
  return Math.max(p.backoffBaseMs, raw + jit);
}

function kindSubdir(base: string, kind: EvolutionTaskKind): string {
  return path.join(base, KIND_DIR[kind]);
}

interface QueueStats {
  totalEnqueued: number; totalCompleted: number; totalFailed: number; totalDead: number;
}

// ── PersistentQueue ──

export class PersistentQueue {
  private base: string;
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(baseDir?: string) {
    this.base = baseDir ?? path.join(os.homedir(), '.my-agent', EVO_DIR);
  }

  async enqueue(task: Omit<EvolutionTask, 'id' | 'enqueuedAt' | 'attempt' | 'nextRunAt' | 'maxAttempts'>): Promise<string> {
    const id = genId();
    const dir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, task.kind));
    await fs.mkdir(dir, { recursive: true });
    const full: EvolutionTask = { ...task, id, attempt: 0, maxAttempts: TIER_PARAMS[task.kind].maxAttempts, nextRunAt: Date.now(), enqueuedAt: Date.now() };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), 'utf-8');
    debugLog(`[queue] Enqueued ${id} (${task.kind})`);
    return id;
  }

  async claim(kind: EvolutionTaskKind): Promise<EvolutionTask | null> {
    const qDir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, kind));
    const iDir = path.join(this.base, INFLIGHT_DIR, kindSubdir(this.base, kind));
    await fs.mkdir(iDir, { recursive: true });
    await fs.mkdir(qDir, { recursive: true });

    let ents: Dirent[];
    try { ents = await fs.readdir(qDir, { withFileTypes: true }); } catch { return null; }
    const files = ents.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name).sort();

    for (const fn of files) {
      const tp = path.join(qDir, fn);
      let task: EvolutionTask;
      try { task = JSON.parse(await fs.readFile(tp, 'utf-8')) as EvolutionTask; } catch { continue; }
      if (Date.now() < task.nextRunAt) continue;

      const lock = path.join(iDir, `${task.id}${LOCK_SUFFIX}`);
      const dest = path.join(iDir, `${task.id}.json`);
      let fd: number;
      try { fd = openSync(lock, 'wx'); closeSync(fd); } catch { continue; }
      try { await fs.rename(tp, dest); } catch { await fs.unlink(lock).catch(() => {}); continue; }

      const t = setInterval(() => { fs.access(lock).then(() => fs.utimes(lock, new Date(), new Date())).catch(() => {}); }, HEARTBEAT_MS);
      this.timers.set(task.id, t);
      debugLog(`[queue] Claimed ${task.id} (${task.kind}, attempt ${task.attempt + 1})`);
      return task;
    }
    return null;
  }

  async complete(id: string, kind: EvolutionTaskKind): Promise<void> {
    this.stopTimer(id);
    const iDir = path.join(this.base, INFLIGHT_DIR, kindSubdir(this.base, kind));
    await fs.unlink(path.join(iDir, `${id}${LOCK_SUFFIX}`)).catch(() => {});
    await fs.unlink(path.join(iDir, `${id}.json`)).catch(() => {});
    debugLog(`[queue] Completed ${id}`);
    await this.incStat('totalCompleted');
  }

  async fail(id: string, kind: EvolutionTaskKind, error: string): Promise<void> {
    this.stopTimer(id);
    const iDir = path.join(this.base, INFLIGHT_DIR, kindSubdir(this.base, kind));
    const lock = path.join(iDir, `${id}${LOCK_SUFFIX}`);
    const tp = path.join(iDir, `${id}.json`);
    await fs.unlink(lock).catch(() => {});

    let task: EvolutionTask;
    try { task = JSON.parse(await fs.readFile(tp, 'utf-8')) as EvolutionTask; } catch { return; }
    task.attempt++;
    task.lastError = { msg: error, at: Date.now() };
    task.nextRunAt = Date.now() + nextDelay(kind, task.attempt);
    await fs.rm(tp, { force: true }).catch(() => {});

    if (task.attempt >= task.maxAttempts) {
      await fs.mkdir(path.join(this.base, DEAD_DIR), { recursive: true });
      await fs.writeFile(path.join(this.base, DEAD_DIR, `${id}.json`), JSON.stringify(task, null, 2), 'utf-8');
      debugLog(`[queue] Dead ${id} (${kind})`);
      await this.incStat('totalDead');
    } else {
      const qDir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, kind));
      await fs.writeFile(path.join(qDir, `${id}.json`), JSON.stringify(task, null, 2), 'utf-8');
      debugLog(`[queue] Requeued ${id} (${kind}) — attempt ${task.attempt}`);
      await this.incStat('totalFailed');
    }
  }

  async deriveTask(parent: EvolutionTask, childKind: EvolutionTaskKind, payload: TaskPayload, scheduledBy: TriggerSource): Promise<string | null> {
    const fp = `${parent.fingerprint}:${childKind}`;
    const qDir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, childKind));
    try {
      for (const e of await fs.readdir(qDir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const ex = JSON.parse(await fs.readFile(path.join(qDir, e.name), 'utf-8')) as EvolutionTask;
        if (ex.fingerprint === fp) return null;
      }
    } catch { /* dir missing */ }
    return this.enqueue({ kind: childKind, priority: 'normal', payload, fingerprint: fp, scheduledBy, parentTaskId: parent.id });
  }

  async recoverInflight(): Promise<string[]> {
    const recovered: string[] = [];
    const kinds: EvolutionTaskKind[] = ['tier0_review', 'tier2_verdict', 'tier3_prompt_opt', 'tier3_ab_promote', 'auto_accept_sweep', 'mem-extract', 'mem-embed'];
    for (const kind of kinds) {
      const iDir = path.join(this.base, INFLIGHT_DIR, kindSubdir(this.base, kind));
      await fs.mkdir(iDir, { recursive: true });
      let ents: Dirent[];
      try { ents = await fs.readdir(iDir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith(LOCK_SUFFIX)) continue;
        const id = e.name.replace(LOCK_SUFFIX, '');
        const lock = path.join(iDir, e.name);
        const tp = path.join(iDir, `${id}.json`);
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs < ZOMBIE_MS) continue;
          await fs.unlink(lock);
          try {
            const task = JSON.parse(await fs.readFile(tp, 'utf-8')) as EvolutionTask;
            task.attempt = 0; task.nextRunAt = Date.now();
            const qDir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, task.kind));
            await fs.mkdir(qDir, { recursive: true });
            await fs.writeFile(path.join(qDir, `${id}.json`), JSON.stringify(task, null, 2), 'utf-8');
            await fs.rm(tp, { force: true }).catch(() => {});
            recovered.push(id);
          } catch { debugLog(`[queue] Orphan lock ${id}`); }
        } catch { /* gone */ }
      }
    }
    return recovered;
  }

  async size(): Promise<{ queue: number; inflight: number; dead: number }> {
    let q = 0, inf = 0, d = 0;
    const ks: EvolutionTaskKind[] = ['tier0_review', 'tier2_verdict', 'tier3_prompt_opt', 'tier3_ab_promote', 'auto_accept_sweep', 'mem-extract', 'mem-embed'];
    for (const k of ks) {
      q += await this.count(path.join(this.base, QUEUE_DIR, kindSubdir(this.base, k)), false);
      inf += await this.count(path.join(this.base, INFLIGHT_DIR, kindSubdir(this.base, k)), true);
    }
    d = await this.count(path.join(this.base, DEAD_DIR), false);
    return { queue: q, inflight: inf, dead: d };
  }

  async requeue(id: string): Promise<void> {
    const dp = path.join(this.base, DEAD_DIR, `${id}.json`);
    try {
      const task = JSON.parse(await fs.readFile(dp, 'utf-8')) as EvolutionTask;
      task.attempt = 0; task.nextRunAt = Date.now(); delete task.lastError;
      const qDir = path.join(this.base, QUEUE_DIR, kindSubdir(this.base, task.kind));
      await fs.mkdir(qDir, { recursive: true });
      await fs.writeFile(path.join(qDir, `${id}.json`), JSON.stringify(task, null, 2), 'utf-8');
      await fs.rm(dp, { force: true }).catch(() => {});
    } catch { /* nop */ }
  }

  private stopTimer(id: string) { const t = this.timers.get(id); if (t) { clearInterval(t); this.timers.delete(id); } }

  private async count(dir: string, excludeLocks: boolean): Promise<number> {
    try {
      const ents = await fs.readdir(dir, { withFileTypes: true });
      return ents.filter(e => e.isFile() && e.name.endsWith('.json') && (!excludeLocks || !e.name.endsWith(LOCK_SUFFIX))).length;
    } catch { return 0; }
  }

  private async incStat(key: 'totalCompleted' | 'totalFailed' | 'totalDead'): Promise<void> {
    try {
      const sp = path.join(this.base, 'stats.json');
      const stats: QueueStats = await (async () => { try { return JSON.parse(await fs.readFile(sp, 'utf-8')) as QueueStats; } catch { return { totalEnqueued: 0, totalCompleted: 0, totalFailed: 0, totalDead: 0 }; } })();
      stats[key]++;
      await fs.mkdir(path.dirname(sp), { recursive: true });
      await fs.writeFile(sp, JSON.stringify(stats, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }
}
