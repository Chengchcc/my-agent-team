import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import type { EventLog, EventSource } from "@my-agent-team/event-log";
import type { RunEventBus } from "./event-bus.js";
import type { BackendConfig } from "../../config.js";

// DDL that must exist in events.db (same file that stores event_log)
const RUN_ATTEMPT_DDL = `
CREATE TABLE IF NOT EXISTS run (
  run_id     TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE TABLE IF NOT EXISTS attempt (
  attempt_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  pid          INTEGER,
  heartbeat_at INTEGER,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempt_run ON attempt(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_run_thread ON run(thread_id, started_at DESC);
`;

export interface RunSupervisorOptions {
  eventLog: EventLog;
  eventBus: RunEventBus;
  config: BackendConfig;
  runnerBin: string;
}

interface ActiveRun {
  runId: string;
  attemptId: string;
  threadId: string;
  child: ChildProcess;
  abortController: AbortController;
}

export class RunSupervisor {
  #active = new Map<string, ActiveRun>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete?: (threadId: string, runId: string) => void;

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = new Database(`${opts.config.dataDir}/events.db`);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    // Fix A: Ensure run/attempt tables exist in events.db
    this.#db.exec(RUN_ATTEMPT_DDL);
  }

  /** Register callback invoked when any run completes (success/error/abort). */
  onRunComplete(fn: (threadId: string, runId: string) => void): void {
    this.#onRunComplete = fn;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Dispose the supervisor's DB connection. */
  dispose(): void {
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

    // Parse stdout NDJSON for low-latency event notification
    let buf = "";
    child.stdout!.on("data", (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          this.#opts.eventBus.emit({
            seq: -1,
            threadId,
            runId,
            event: ev,
            ts: Date.now(),
          });
        } catch {
          /* skip corrupt lines */
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
      // - User cancel: abortController.signal.aborted is true
      // - Signal death (SIGTERM/SIGKILL from cancel): signal is non-null
      // - Clean exit 0: succeeded
      // - Clean exit non-zero / crash: error
      if (ac.signal.aborted || signal !== null) {
        this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      } else if (code === 0) {
        this.#db.run("UPDATE run SET status = 'succeeded', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      } else {
        this.#db.run("UPDATE run SET status = 'error', ended_at = ? WHERE run_id = ?", [exitNow, runId]);
      }

      // Fix B: Notify service to release thread lock
      if (this.#onRunComplete) {
        this.#onRunComplete(threadId, runId);
      }
    });

    this.#active.set(runId, { runId, attemptId, threadId, child, abortController: ac });

    return { runId, attemptId, pid };
  }

  /** Send SIGTERM to subprocess; cancelGraceMs fallback to SIGKILL. */
  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;

    // Fix D: Signal abort so exit handler classifies correctly
    run.abortController.abort("cancelled");

    run.child.kill("SIGTERM");
    setTimeout(() => {
      if (run.child.exitCode === null) {
        run.child.kill("SIGKILL");
      }
    }, this.#opts.config.cancelGraceMs);
    return true;
  }

  /** On restart: discover live runs by heartbeat, mark stale ones interrupted.
   *  Live runs are re-registered in #active for cancel support. */
  async rediscover(eventSource: EventSource): Promise<void> {
    const rows = this.#db
      .query("SELECT * FROM attempt WHERE ended_at IS NULL")
      .all() as { attempt_id: string; run_id: string; thread_id?: string; pid: number | null; heartbeat_at: number | null }[];

    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) {
        // Fix E: Re-register in #active so cancel() works post-restart
        // We don't have the ChildProcess object, but cancel can send SIGTERM by pid
        const ac = new AbortController();
        this.#active.set(row.run_id, {
          runId: row.run_id,
          attemptId: row.attempt_id,
          threadId: row.thread_id ?? "",
          child: null as unknown as ChildProcess, // no live handle; cancel works via pid
          abortController: ac,
        });
        console.log(`[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`);
      } else {
        const now = Date.now();
        this.#db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [now, row.run_id]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, row.attempt_id]);
        console.log(`[supervisor] marked interrupted: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`);
      }
    }
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
