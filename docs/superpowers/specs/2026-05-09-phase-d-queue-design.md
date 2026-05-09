# Phase D — Persistent Task Queue Design

## Goal

Survive process crashes and restarts. All review tasks are persisted to disk, claimed atomically, and backed off on failure. The queue is the single source of truth for task state, replacing in-memory pending slots.

## Architecture

```
NudgeSignal → Defense (L1-L5, CB) → PersistentQueue.enqueue()
                                              │
                           ┌──────────────────┘
                           ▼
              ~/.my-agent/evolution/
              ├── queue/     待执行
              ├── inflight/   执行中 (+.lock heartbeat)
              └── dead/       失败≥5次
```

**Relation to existing layers:**
- **ReviewSlot** (L5): in-memory pending → deprecated. Queue replaces it.
- **ReviewBackoff** (L2): in-memory backoff → computed by queue on fail()
- **TaskRunner** (C1): unchanged — receives claimed task and executes it
- **TurnSettledDetector** (C2): unchanged — triggers queue drain attempt

## Data Model

```ts
interface QueueTask {
  id: string;           // ulid — sortable unique ID
  signal: 'error_burst' | 'complex_task' | 'periodic';
  trigger: 'memory_review' | 'skill_review' | 'combined_review';
  payload: {
    sessionId: string;
    traceRunId: string;
    fingerprint: string;
    reason: string;
    trace: TraceRun;    // serialized inline (Phase G will add sampling)
  };
  attempt: number;      // 0..5
  nextRunAt: number;    // unix ms — earliest time this task can be claimed
  enqueuedAt: number;   // unix ms
  lastError?: string;
}
```

## File Layout

```
~/.my-agent/evolution/
├── queue/
│   └── <ulid>.json          # task file, ready to claim
├── inflight/
│   ├── <ulid>.json          # task file (moved from queue/)
│   └── <ulid>.json.lock     # empty lock file, mtime = heartbeat
├── dead/
│   └── <ulid>.json          # ≥5 failures
└── stats.json               # { totalEnqueued, totalCompleted, totalFailed, totalDead }
```

**Why file-per-task instead of single JSON file:**
- No read-modify-write race on claim
- Atomic claim via O_EXCL file creation (POSIX guaranteed)
- Crash-safe: each file is self-contained
- Dead-letter queue is just a mv

## Claim Protocol (the critical path)

```
claim():
  1. readdir(queue/) sorted by ulid (≈ time order)
  2. for each task where task.nextRunAt <= Date.now():
     a. try: fs.open(`inflight/<id>.json.lock`, 'wx')  ← O_EXCL, atomic
     b. if EEXIST: skip (another worker claimed it)
     c. fs.rename(`queue/<id>.json`, `inflight/<id>.json`)
     d. start heartbeat: setInterval(touch lock mtime, 30s)
     e. return task
  3. return null (nothing ready)
```

**Why this works:**
- `fs.open('wx')` is atomic across all processes/threads on the same host
- The rename after lock acquisition is safe: lock holder owns the task
- Heartbeat prevents zombie detection from killing live tasks

## Fail & Backoff

```
fail(id, error):
  1. task = read `inflight/<id>.json`
  2. clear heartbeat
  3. unlink `inflight/<id>.json.lock`
  4. task.attempt++
  5. if task.attempt >= 5:
     a. rename to `dead/<id>.json`
  6. else:
     a. task.nextRunAt = now + nextDelay(task.attempt)
     b. write task to `queue/<id>.json`
     c. unlink `inflight/<id>.json`

nextDelay(attempt):
  raw = min(30s * 2^attempt, 6h)
  jitter = raw * 0.2 * (2 * random - 1)
  return max(30s, raw + jitter)
```

Backoff schedule: 30s → 60s → 2m → 4m → 8m → dead

## Zombie Recovery (on boot)

```
recoverInflight():
  1. for each `<id>.json.lock` in inflight/:
     a. stat mtime
     b. if Date.now() - mtime > 10min:
        - unlink lock
        - rename `inflight/<id>.json` → `queue/<id>.json`
        - reset attempt to 0
        - log recovered task
```

10-minute threshold is generous: heartbeat is every 30s, so 10min means ~20 missed heartbeats. This handles:
- Process crash (SIGKILL)
- Event loop blocked for extended period
- Host suspend/resume

## API Surface

```ts
class PersistentQueue {
  constructor(baseDir?: string)  // default: ~/.my-agent/evolution

  // Write
  enqueue(task: Omit<QueueTask, 'id' | 'enqueuedAt' | 'attempt'>): Promise<string>
  claim(): Promise<QueueTask | null>
  complete(id: string): Promise<void>
  fail(id: string, error: string): Promise<void>

  // Read
  size(): Promise<{ queue: number; inflight: number; dead: number }>
  getStats(): Promise<QueueStats>

  // Lifecycle
  recoverInflight(): Promise<string[]>

  // Admin
  requeue(id: string): Promise<void>  // dead → queue, reset attempt
  purge(): Promise<void>              // clear dead/
}
```

## Integration with Existing Modules

### evolution/index.ts

```ts
// Replace in-memory ReviewSlot with PersistentQueue
const queue = new PersistentQueue();

// When nudge fires:
review(nudgeResult, trace) {
  // ... defense checks (CB, backoff, IdleGate) ...
  if (!idleGate.canRun()) {
    queue.enqueue({ signal, trigger, payload: {...} });
    return;  // task persisted, will be claimed later
  }
  // ... if idle, claim and run immediately ...
}

// Drain function (called on loop_settled, idle, startup):
async drainQueue() {
  while (task = await queue.claim()) {
    runner.run(() => executeReview(task), {
      onComplete: () => queue.complete(task.id),
      onError: () => queue.fail(task.id, error),
    });
  }
}
```

### trace/index.ts
- On startup: call `queue.recoverInflight()` after trace middleware is created
- Wire `settledDetector.setCallback(() => evolution.drainQueue())`

### ReviewSlot deprecation
- ReviewSlot becomes unused. Keep the file but remove from export.
- Queue handles priority implicitly: claim() returns the earliest-ready task (ulid sort ≈ time order). Priority-based ordering can be added in Phase E (Drainer).

## Edge Cases

| Scenario | Behavior |
|---|---|
| Crash during claim() after lock but before rename | recoverInflight: orphan lock with no .json → cleaned up |
| Crash during claim() after rename | recoverInflight: .json + stale lock → recovered to queue |
| Crash during fail() mid-write | Recover reads partial task → moves to dead as precaution |
| Two drainers claim same task | O_EXCL guarantees exactly one winner |
| Queue has 1000 tasks | claim() reads dir, returns first ready task (O(n) but directories scale to 10k entries fine) |
| Disk full | enqueue/fail ops fail, logged, bubbled to caller |
| Task file corrupted | JSON parse fails → move to dead/, log warning |

## What This Does NOT Do (deferred)

- **Priority ordering**: claim() returns earliest-ready by ulid. Phase E adds Drainer with priority filter.
- **Multi-host coordination**: O_EXCL works on single filesystem only. For distributed, need Redis/DB.
- **Task TTL**: Tasks never expire from queue. Phase G adds staleness check.
- **Trace dedup at enqueue time**: Done in NudgeEngine (fingerprint). Queue trusts caller.

## Files Changed

| File | Change |
|---|---|
| `src/evolution/persistent-queue.ts` | NEW — 180 LOC |
| `src/evolution/index.ts` | Replace in-memory slot with queue + drain function |
| `src/trace/index.ts` | Wire queue.recoverInflight on startup |
| `src/runtime.ts` or `runtime-providers.ts` | Wire queue drain to settled detector |
| `tests/evolution/persistent-queue.test.ts` | NEW — ~15 tests |

## Verification

- `bun test tests/evolution/` passes (including queue tests)
- Simulated crash test: enqueue → claim → kill process → restart → recoverInflight → task back in queue
- 1000 concurrent enqueues: no ID collisions, no lock leaks
- 5 consecutive fails → task in dead/
