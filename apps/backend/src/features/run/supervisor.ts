import { Database } from "bun:sqlite";
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
  {
    name: "events_v5_run_kind_parent",
    id: 3004,
    up: `
      ALTER TABLE run ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE run ADD COLUMN parent_run_id TEXT;
    `,
  },
  {
    name: "events_v6_run_agent_id",
    id: 3005,
    up: `ALTER TABLE run ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''`,
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
  /** M14.7: Runner registry — the only way to reach runner daemons. */
  registry: RunnerRegistry;
}

export interface RunSession {
  runId: string;
  attemptId: string;
  threadId: string;
  agentId: string;
  kind: "main" | "reflect";
  transport: RunnerTransport;
  abortController: AbortController;
}

/** No-op transport stub — used when a real transport is unavailable
 *  (post-restart rediscover, testing). Cancel degrades to reaper timeout. */
export const NOOP_TRANSPORT: RunnerTransport = {
  ready() { return Promise.resolve(); },
  send() {},
  onMessage() {},
  onClose() {},
  close() { return Promise.resolve(); },
};

export class RunSupervisor {
  #active = new Map<string, RunSession>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<(threadId: string, runId: string, status: string) => void | Promise<void>> =
    [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;
  #deltaSubs = new Map<string, Set<ReadableStreamDefaultController>>();
  #boundTransports = new Set<RunnerTransport>();

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
        `SELECT a.attempt_id, a.run_id, a.heartbeat_at, r.thread_id
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
      attempt_id: string;
      run_id: string;
      heartbeat_at: number | null;
      thread_id: string;
    }[];

    let reaped = false;
    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) continue; // fresh

      // M14.7: daemon runs have no backend-visible pid — heartbeat timeout is the sole liveness signal.
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
        fn(row.thread_id, row.run_id, "interrupted");
      }

      console.log(
        `[supervisor] reaped stale run: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`,
      );
      reaped = true;
    }
    return reaped;
  }

  /** Register callback invoked when any run completes (success/error/abort). Supports multiple listeners. */
  onRunComplete(
    fn: (threadId: string, runId: string, status: string) => void | Promise<void>,
  ): void {
    this.#onRunComplete.push(fn);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Expose active run session for test assertions (agentId/kind/threadId). */
  getActive(runId: string): RunSession | undefined {
    return this.#active.get(runId);
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

  // ─── M14.7: Run lifecycle (registry-based) ──────────────────────

  /**
   * Start a NEW main run. Creates run + attempt rows.
   */
  async startMainRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }> {
    const agentId = (spec.agentId as string) ?? "default";
    return this.#beginAndSend(runId, threadId, agentId, spec, "main");
  }

  async resumeRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }> {
    const agentId = (spec.agentId as string) ?? "default";
    this.#db.run("UPDATE run SET status = 'running' WHERE run_id = ?", [runId]);
    return this.#beginAttempt(runId, threadId, agentId, spec, "main");
  }

  async beginReflectRun(
    runId: string,
    threadId: string,
    parentRunId: string,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }> {
    const agentId = (spec.agentId as string) ?? "default";
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, agent_id, status, started_at, kind, parent_run_id) VALUES (?, ?, ?, 'running', ?, 'reflect', ?)",
      [runId, threadId, agentId, now, parentRunId],
    );
    return this.#beginAttempt(runId, threadId, agentId, spec, "reflect");
  }

  /** Internal: create run row (main only; reflect uses beginReflectRun), then delegate to #beginAttempt. */
  async #beginAndSend(
    runId: string,
    threadId: string,
    agentId: string,
    spec: Record<string, unknown>,
    kind: "main" | "reflect",
  ): Promise<{ runId: string; attemptId: string }> {
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, agent_id, status, started_at, kind) VALUES (?, ?, ?, 'running', ?, ?)",
      [runId, threadId, agentId, now, kind],
    );
    return this.#beginAttempt(runId, threadId, agentId, spec, kind);
  }

  /** Shared tail: get transport, create attempt, register in #active, send start. */
  async #beginAttempt(
    runId: string,
    threadId: string,
    agentId: string,
    spec: Record<string, unknown>,
    kind: "main" | "reflect",
  ): Promise<{ runId: string; attemptId: string }> {
    const transport = await this.#opts.registry.transportFor(agentId);
    this.#bindTransport(transport);

    const now = Date.now();
    const attemptId = crypto.randomUUID();
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, heartbeat_at, started_at) VALUES (?, ?, ?, ?)",
      [attemptId, runId, now, now],
    );

    const ac = new AbortController();
    this.#active.set(runId, {
      runId,
      attemptId,
      threadId,
      agentId,
      kind,
      transport,
      abortController: ac,
    });

    transport.send({ type: "start", runId, spec });
    return { runId, attemptId };
  }

  #bindTransport(transport: RunnerTransport): void {
    if (this.#boundTransports.has(transport)) return;
    this.#boundTransports.add(transport);
    transport.onMessage((msg) => {
      void this.#handleRunnerMessage(msg, transport);
    });
  }

  async #handleRunnerMessage(raw: unknown, sourceTransport: RunnerTransport): Promise<void> {
    const msg = raw as Record<string, unknown>;
    const runId = msg.runId as string;
    const session = this.#active.get(runId);
    const transport = session?.transport ?? sourceTransport;
    switch (msg.type) {
      case "run_started": {
        // Fire-and-forget: daemon notifies backend that reflection has started.
        // Backend records the run row + attempt; daemon continues independently.
        void this.beginReflectRun(
          runId,
          msg.threadId as string,
          (msg.parentRunId as string) ?? "",
          (msg.spec as Record<string, unknown>) ?? {},
        ).catch((err: unknown) => {
          console.error(
            `[supervisor] beginReflectRun failed for ${runId}:`,
            (err as Error).message,
          );
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
        await Promise.all(this.#onRunComplete.map((fn) => fn(threadId, runId, status)));
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
    const session = this.#active.get(runId);
    if (!session) return false;
    session.abortController.abort("cancelled");
    session.transport.send({ type: "abort", runId });
    return true;
  }

  /** M14.7: Cancel all active runs. Used during shutdown. */
  cancelAll(): void {
    for (const runId of this.#active.keys()) {
      this.cancel(runId);
    }
  }

  /** On restart: discover live runs by heartbeat, re-register them for cancel support.
   *  Stale runs are handled by the shared #reapStaleRuns() method. */
  async rediscover(_eventSource: EventSource): Promise<void> {
    // JOIN run table — agent_id, kind, thread_id live on run, not attempt
    const rows = this.#db
      .query(
        `SELECT a.attempt_id, a.run_id, a.heartbeat_at,
                r.agent_id, r.kind, r.thread_id
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
      attempt_id: string;
      run_id: string;
      heartbeat_at: number | null;
      agent_id: string;
      kind: "main" | "reflect";
      thread_id: string;
    }[];

    // Phase 1: re-register live runs in #active for post-restart cancel support.
    // Use no-op transport stub — we do NOT call registry.transportFor here because
    // DevRunnerRegistry.transportFor spawns a new daemon (which would kill the
    // still-running daemon via stale pidfile cleanup). Post-restart cancel is
    // handled by the reaper timeout; the no-op stub prevents crash on cancel().
    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) {
        const ac = new AbortController();
        this.#active.set(row.run_id, {
          runId: row.run_id,
          attemptId: row.attempt_id,
          threadId: row.thread_id,
          agentId: row.agent_id,
          kind: row.kind,
          transport: NOOP_TRANSPORT,
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
}
