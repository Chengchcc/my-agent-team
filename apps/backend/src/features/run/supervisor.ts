import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import type { EventLog, EventSource } from "@my-agent-team/event-log";
import type { BackendConfig } from "../../config.js";

// Migrations for events.db — run/attempt tables (same file that stores event_log).
// Uses the same _migrations ledger pattern as backend.db.
const EVENTS_DB_MIGRATIONS = [
  {
    name: "events_v1_run",
    id: 3000,
    up: `CREATE TABLE IF NOT EXISTS run (
      run_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    )`,
  },
  {
    name: "events_v2_attempt",
    id: 3001,
    up: `CREATE TABLE IF NOT EXISTS attempt (
      attempt_id   TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
      pid          INTEGER,
      heartbeat_at INTEGER,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER
    )`,
  },
  {
    name: "events_v3_attempt_run_idx",
    id: 3002,
    up: `CREATE INDEX IF NOT EXISTS idx_attempt_run ON attempt(run_id, started_at)`,
  },
  {
    name: "events_v4_run_thread_idx",
    id: 3003,
    up: `CREATE INDEX IF NOT EXISTS idx_run_thread ON run(thread_id, started_at DESC)`,
  },
];

function runEventsDbMigrations(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, id INTEGER NOT NULL, ran_at INTEGER NOT NULL)");
  const ran = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  for (const m of EVENTS_DB_MIGRATIONS) {
    if (ran.has(m.name)) continue;
    db.exec(m.up);
    db.run("INSERT INTO _migrations (name, id, ran_at) VALUES (?, ?, ?)", [m.name, m.id, Date.now()]);
  }
}

export interface RunSupervisorOptions {
  eventLog: EventLog;
  config: BackendConfig;
  runnerBin: string;
}

interface ActiveRun {
  runId: string;
  attemptId: string;
  threadId: string;
  pid: number;
  child: ChildProcess | null; // null after restart (no live handle)
  abortController: AbortController;
}

export class RunSupervisor {
  #active = new Map<string, ActiveRun>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<(threadId: string, runId: string) => void> = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false; // M11 fix: concurrency guard for async reaper

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = new Database(`${opts.config.dataDir}/events.db`);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    // Fix A + FIX-6: Ensure run/attempt tables exist in events.db via unified migration ledger
    runEventsDbMigrations(this.#db);

    // M11: Start running reaper
    this.#startReaper();
  }

  /** M11: Start periodic reaper to harvest stale runs. */
  #startReaper(): void {
    const interval = this.#opts.config.reaperIntervalMs > 0
      ? this.#opts.config.reaperIntervalMs
      : Math.min(this.#opts.config.heartbeatTimeoutMs / 2, 30_000);
    this.#reaperTimer = setInterval(() => {
      if (this.#reaping) return; // concurrency guard: skip if previous tick still running
      this.#reaping = true;
      void this.#reapStaleRuns().finally(() => { this.#reaping = false; });
    }, interval);
  }

  /** M11: Shared stale-run detection. Used by both reaper (periodic) and rediscover (startup).
   *  Returns true if any runs were reaped. */
  async #reapStaleRuns(): Promise<boolean> {
    // JOIN attempt with run to get thread_id for EventLog append
    const rows = this.#db
      .query(
        `SELECT a.attempt_id, a.run_id, a.pid, a.heartbeat_at, r.thread_id
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
        attempt_id: string; run_id: string; pid: number | null;
        heartbeat_at: number | null; thread_id: string;
      }[];

    let reaped = false;
    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) continue; // fresh

      // M11: Secondary check — probe process before final verdict
      if (row.pid) {
        try {
          process.kill(row.pid, 0);
          // Process still alive — might be stall, check stepStallTimeout
          if (age < this.#opts.config.heartbeatTimeoutMs + this.#opts.config.stepStallTimeoutMs) {
            continue; // within stall grace window, don't reap yet
          }
        } catch {
          // Process dead — immediately reap
        }
      }

      const now = Date.now();
      // FIX: transactional write — run + attempt status update is atomic
      this.#db.transaction(() => {
        this.#db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [now, row.run_id]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, row.attempt_id]);
      })();

      // Append terminal event to EventLog
      try {
        await this.#opts.eventLog.append(row.thread_id, row.run_id, {
          type: "interrupted",
          payload: { reason: "heartbeat_timeout" },
        });
      } catch {
        // EventLog append is best-effort for reaper
      }

      // Trigger onRunComplete listeners (releases M10 locks, notifies Growth)
      for (const fn of this.#onRunComplete) {
        fn(row.thread_id, row.run_id);
      }

      console.log(`[supervisor] reaped stale run: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`);
      reaped = true;
    }
    return reaped;
  }

  /** Register callback invoked when any run completes (success/error/abort). Supports multiple listeners. */
  onRunComplete(fn: (threadId: string, runId: string) => void): void {
    this.#onRunComplete.push(fn);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Expose DB for read queries (GET /runs/:id metadata). */
  getDb(): Database {
    return this.#db;
  }

  /** Dispose the supervisor's DB connection and stop reaper. */
  async dispose(): Promise<void> {
    // M11: Stop reaper first, then wait for in-flight tick, then close DB
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = undefined;
    }
    // Wait for any in-flight #reapStaleRuns to complete before closing DB
    while (this.#reaping) {
      await new Promise((r) => setTimeout(r, 10));
    }
    this.#db.close();
  }

  /** Fork subprocess and return attemptId. Non-blocking. */
  fork(runId: string, threadId: string, specJson: string): { runId: string; attemptId: string; pid: number } {
    const attemptId = crypto.randomUUID();
    const now = Date.now();

    // Fix H: Write ledger BEFORE spawn (DB is source of truth)
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)",
      [runId, threadId, now],
    );
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)",
      [attemptId, runId, null, now, now], // pid filled after spawn
    );

    const ac = new AbortController();
    const child = spawn("bun", [this.#opts.runnerBin], {
      env: { ...process.env, AGENT_SPEC: specJson },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = child.pid!;

    // Update attempt with actual pid
    this.#db.run("UPDATE attempt SET pid = ? WHERE attempt_id = ?", [pid, attemptId]);

    // Parse stdout NDJSON for optional low-latency notification.
    // Events are durably persisted via EventSink.append in the subprocess;
    // stdout is an acceleration channel — losing it never loses events (iron law 4).
    let buf = "";
    child.stdout!.on("data", (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          // JSON.parse is untyped but runner always writes valid AgentEvent
          const ev = JSON.parse(line) as unknown;
          void this.#opts.eventLog.append(threadId, runId, ev as Parameters<EventLog["append"]>[2]).catch(() => {
            // best-effort; runner's direct DB write is primary
          });
        } catch {
          // skip malformed lines
        }
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      process.stderr.write(`[supervisor:${runId}] ${data}`);
    });

    child.on("exit", (code, signal) => {
      this.#active.delete(runId);
      const exitNow = Date.now();
      this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [exitNow, attemptId]);

      // Fix D: Determine status correctly
      if (ac.signal.aborted || signal !== null) {
        this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      } else if (code === 0) {
        this.#db.run("UPDATE run SET status = 'succeeded', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      } else {
        this.#db.run("UPDATE run SET status = 'error', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      }

      // Fix B: Notify all listeners to release locks
      for (const fn of this.#onRunComplete) {
        fn(threadId, runId);
      }
    });

    this.#active.set(runId, { runId, attemptId, threadId, pid, child, abortController: ac });

    return { runId, attemptId, pid };
  }

  /** Send SIGTERM to subprocess; cancelGraceMs fallback to SIGKILL. */
  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;

    // Fix D: Signal abort so exit handler classifies correctly
    run.abortController.abort("cancelled");

    // Fix FIX-3: handle post-restart (child is null, cancel by pid)
    if (run.child) {
      run.child.kill("SIGTERM");
      setTimeout(() => {
        if (run.child && run.child.exitCode === null) {
          run.child.kill("SIGKILL");
        }
      }, this.#opts.config.cancelGraceMs);
    } else {
      // post-restart: no ChildProcess handle, use process.kill with stored pid
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // Process already dead — mark aborted immediately
        const now = Date.now();
        this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [now, runId]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, run.attemptId]);
        this.#active.delete(runId);
      }
    }
    return true;
  }

  /** On restart: discover live runs by heartbeat, re-register them for cancel support.
   *  Stale runs are handled by the shared #reapStaleRuns() method. */
  async rediscover(_eventSource: EventSource): Promise<void> {
    const rows = this.#db
      .query("SELECT * FROM attempt WHERE ended_at IS NULL")
      .all() as { attempt_id: string; run_id: string; thread_id?: string; pid: number | null; heartbeat_at: number | null }[];

    // Phase 1: re-register live runs in #active for post-restart cancel support
    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) {
        const ac = new AbortController();
        this.#active.set(row.run_id, {
          runId: row.run_id,
          attemptId: row.attempt_id,
          threadId: row.thread_id ?? "",
          pid: row.pid ?? 0,
          child: null,
          abortController: ac,
        });
        console.log(`[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`);
      }
    }

    // Phase 2: delegate stale runs to shared reap logic (includes EventLog append + onRunComplete)
    await this.#reapStaleRuns();
  }

  /** Cancel by pid (used post-restart when ChildProcess handle is unavailable). */
  cancelByPid(runId: string, pid: number): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;
    run.abortController.abort("cancelled");
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already dead — just update status
      const now = Date.now();
      this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [now, runId]);
      this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, run.attemptId]);
      this.#active.delete(runId);
      return false;
    }
    return true;
  }
}
