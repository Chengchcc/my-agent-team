import { Database } from "bun:sqlite";
import type { ChildProcess } from "node:child_process";
import type { EventLog, EventSource } from "@my-agent-team/event-log";
import type { RunnerTransport } from "@my-agent-team/runner-protocol";
import type { BackendConfig } from "../../config.js";
import type { RunnerRegistry } from "./runner-registry.js";

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
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, id INTEGER NOT NULL, ran_at INTEGER NOT NULL)",
  );
  const ran = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  for (const m of EVENTS_DB_MIGRATIONS) {
    if (ran.has(m.name)) continue;
    db.exec(m.up);
    db.run("INSERT INTO _migrations (name, id, ran_at) VALUES (?, ?, ?)", [
      m.name,
      m.id,
      Date.now(),
    ]);
  }
}

export interface RunSupervisorOptions {
  eventLog: EventLog;
  config: BackendConfig;
  /** M14.7: Daemon transport for resident runner. When set, start() is preferred over fork(). */
  transport?: RunnerTransport;
  /** M14.7: Runner registry for multi-agent daemon transport. */
  registry?: RunnerRegistry;
}

interface ActiveRun {
  runId: string;
  attemptId: string;
  threadId: string;
  pid: number | null; // null for daemon runs
  child: ChildProcess | null; // null after restart or for daemon runs
  abortController: AbortController;
}

export class RunSupervisor {
  #active = new Map<string, ActiveRun>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<(threadId: string, runId: string) => void | Promise<void>> = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false; // M11 fix: concurrency guard for async reaper
  // M13: In-memory delta fan-out for /stream SSE. text_delta events never hit EventLog.
  #deltaSubs = new Map<string, Set<ReadableStreamDefaultController>>();

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = new Database(`${opts.config.dataDir}/events.db`);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    // Fix A + FIX-6: Ensure run/attempt tables exist in events.db via unified migration ledger
    runEventsDbMigrations(this.#db);

    // M14.7: Auto-wire daemon transport if configured
    if (opts.transport) {
      opts.transport.onMessage((msg) => this.#handleDaemonMessage(msg));
    }

    // M11: Start running reaper
    this.#startReaper();
  }

  /** M11: Start periodic reaper to harvest stale runs. */
  #startReaper(): void {
    const interval =
      this.#opts.config.reaperIntervalMs > 0
        ? this.#opts.config.reaperIntervalMs
        : Math.min(this.#opts.config.heartbeatTimeoutMs / 2, 30_000);
    this.#reaperTimer = setInterval(() => {
      if (this.#reaping) return; // concurrency guard: skip if previous tick still running
      this.#reaping = true;
      void this.#reapStaleRuns().finally(() => {
        this.#reaping = false;
      });
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
      attempt_id: string;
      run_id: string;
      pid: number | null;
      heartbeat_at: number | null;
      thread_id: string;
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
        this.#db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [
          now,
          row.run_id,
        ]);
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

      console.log(
        `[supervisor] reaped stale run: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`,
      );
      reaped = true;
    }
    return reaped;
  }

  /** Register callback invoked when any run completes (success/error/abort). Supports multiple listeners. */
  onRunComplete(fn: (threadId: string, runId: string) => void | Promise<void>): void {
    this.#onRunComplete.push(fn);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Expose DB for read queries (GET /runs/:id metadata). */
  getDb(): Database {
    return this.#db;
  }

  /** M13: Subscribe to ephemeral text_delta events for a run. Returns a ReadableStream
   *  of SSE-ready strings. Deltas are in-memory only — never touch EventLog. */
  subscribeDelta(runId: string): ReadableStream {
    let controllers = this.#deltaSubs.get(runId);
    if (!controllers) {
      controllers = new Set();
      this.#deltaSubs.set(runId, controllers);
    }

    let ctrl: ReadableStreamDefaultController | null = null;
    return new ReadableStream({
      start: (controller) => {
        ctrl = controller;
        controllers?.add(controller);
      },
      cancel: () => {
        if (ctrl) {
          controllers?.delete(ctrl);
          if (controllers?.size === 0) this.#deltaSubs.delete(runId);
        }
      },
    });
  }

  /** M13.1: Push any named SSE event to all delta subscribers for this run. */
  #pushEphemeral(runId: string, event: string, data: unknown): void {
    const controllers = this.#deltaSubs.get(runId);
    if (!controllers || controllers.size === 0) return;
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of controllers) {
      try {
        ctrl.enqueue(new TextEncoder().encode(line));
      } catch {
        controllers.delete(ctrl);
      }
    }
    if (controllers.size === 0) this.#deltaSubs.delete(runId);
  }

  /** M13: Close all delta subscribers for a run and clean up. */
  #closeDeltaSubs(runId: string): void {
    const controllers = this.#deltaSubs.get(runId);
    if (!controllers) return;
    for (const ctrl of controllers) {
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    }
    this.#deltaSubs.delete(runId);
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
    // M13: close all delta subscribers
    for (const runId of this.#deltaSubs.keys()) {
      this.#closeDeltaSubs(runId);
    }
    this.#db.close();
  }

  /** Fork subprocess and return attemptId. Non-blocking.
   *  @deprecated Use start() with daemon transport (M14.7). */
  fork(
    runId: string,
    threadId: string,
    specJson: string,
  ): { runId: string; attemptId: string; pid: number } {
    // M14.7: Delegate to daemon transport when available
    if (this.#opts.transport) {
      const spec = JSON.parse(specJson) as Record<string, unknown>;
      const { attemptId } = this.start(runId, threadId, spec);
      return { runId, attemptId, pid: 0 };
    }
    throw new Error("fork() is deprecated — use start() with daemon transport (M14.7)");
  }

  // ─── M14.7: Daemon transport path ───────────────────────────────

  /**
   * Start a run via the resident daemon transport instead of forking a child process.
   * Only valid when transport is configured in RunSupervisorOptions.
   */
  start(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
    opts?: { reflect?: boolean },
  ): { runId: string; attemptId: string } {
    const transport = this.#opts.transport;
    if (!transport) throw new Error("Daemon transport not configured");

    const attemptId = crypto.randomUUID();
    const now = Date.now();

    this.#db.run(
      "INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)",
      [runId, threadId, now],
    );
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, NULL, ?, ?)",
      [attemptId, runId, now, now],
    );

    const ac = new AbortController();
    this.#active.set(runId, {
      runId,
      attemptId,
      threadId,
      pid: 0,
      child: null,
      abortController: ac,
    });

    transport.send({
      type: "start",
      runId,
      spec: spec as Record<string, unknown>,
      reflect: opts?.reflect,
    });

    return { runId, attemptId };
  }

  /** Handle incoming daemon transport messages. Auto-wired in constructor. */
  #beginAttempt(o: {
    runId: string;
    threadId: string;
    kind: "main" | "reflect";
    parentRunId?: string;
  }): void {
    const attemptId = crypto.randomUUID();
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)",
      [o.runId, o.threadId, now],
    );
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, NULL, ?, ?)",
      [attemptId, o.runId, now, now],
    );
    this.#active.set(o.runId, {
      runId: o.runId,
      attemptId,
      threadId: o.threadId,
      pid: null,
      child: null,
      abortController: new AbortController(),
    });
  }

  async #handleDaemonMessage(raw: unknown): Promise<void> {
    const msg = raw as Record<string, unknown>;
    const runId = msg.runId as string;
    let transport: RunnerTransport | undefined;
    try {
      transport = await this.#opts.registry?.transportFor(
        (msg as { agentId?: string }).agentId ?? "default",
      );
    } catch {
      /* ignore */
    }
    if (!transport) transport = this.#opts.transport;
    switch (msg.type) {
      case "run_started": {
        this.#beginAttempt({
          runId,
          threadId: msg.threadId as string,
          kind: (msg.kind as "reflect") ?? "reflect",
          parentRunId: msg.parentRunId as string | undefined,
        });
        break;
      }
      case "event": {
        void this.#opts.eventLog
          .append(this.#threadIdFor(runId), runId, msg.event as Parameters<EventLog["append"]>[2])
          .catch(() => {});
        break;
      }
      case "delta": {
        const ev = msg.event as { type?: string; payload?: unknown };
        if (ev.type && ev.payload) this.#pushEphemeral(runId, ev.type, ev.payload);
        break;
      }
      case "heartbeat": {
        this.#db.run("UPDATE attempt SET heartbeat_at = ? WHERE run_id = ? AND ended_at IS NULL", [
          Date.now(),
          runId,
        ]);
        break;
      }
      case "run_done": {
        const status = msg.status as string;
        const exitNow = Date.now();
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", [
          exitNow,
          runId,
        ]);
        this.#db.run("UPDATE run SET status = ?, ended_at = ? WHERE run_id = ?", [
          status,
          exitNow,
          runId,
        ]);
        this.#closeDeltaSubs(runId);
        this.#active.delete(runId);
        const threadId = this.#threadIdFor(runId);
        // Always fire lifecycle hooks (lock release, cleanup)
        await Promise.all(this.#onRunComplete.map((fn) => fn(threadId, runId)));
        // Only send run_finalized after all listeners complete (D19, ledger, etc.)
        if (transport) transport.send({ type: "run_finalized", runId });
        break;
      }
      default:
        break;
    }
  }

  #threadIdFor(runId: string): string {
    const active = this.#active.get(runId);
    if (active) return active.threadId;
    const row = this.#db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
      | { thread_id: string }
      | undefined;
    if (!row) throw new Error(`unknown runId: ${runId}`);
    return row.thread_id;
  }

  /** Send SIGTERM to subprocess; cancelGraceMs fallback to SIGKILL. */
  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;

    // M14.7: If transport is available, send abort message
    if (this.#opts.transport && !run.child) {
      this.#opts.transport.send({ type: "abort", runId });
      return true;
    }

    // Legacy: kill child process

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
    } else if (run.pid !== null) {
      // post-restart: no ChildProcess handle, use process.kill with stored pid
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // Process already dead — mark aborted immediately
        const now = Date.now();
        this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [
          now,
          runId,
        ]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, run.attemptId]);
        this.#active.delete(runId);
      }
    }
    return true;
  }

  /** On restart: discover live runs by heartbeat, re-register them for cancel support.
   *  Stale runs are handled by the shared #reapStaleRuns() method. */
  async rediscover(_eventSource: EventSource): Promise<void> {
    const rows = this.#db.query("SELECT * FROM attempt WHERE ended_at IS NULL").all() as {
      attempt_id: string;
      run_id: string;
      thread_id?: string;
      pid: number | null;
      heartbeat_at: number | null;
    }[];

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
        console.log(
          `[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`,
        );
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
      this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [
        now,
        runId,
      ]);
      this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, run.attemptId]);
      this.#active.delete(runId);
      return false;
    }
    return true;
  }
}
