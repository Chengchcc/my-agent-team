import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import type { EventLog, EventSource } from "@my-agent-team/event-log";
import type { RunEventBus } from "./event-bus.js";
import type { BackendConfig } from "../../config.js";

export interface RunSupervisorOptions {
  eventLog: EventLog;
  eventBus: RunEventBus;
  config: BackendConfig;
  runnerBin: string;
}

interface ActiveRun {
  runId: string;
  attemptId: string;
  child: ChildProcess;
  abortController: AbortController;
}

export class RunSupervisor {
  #active = new Map<string, ActiveRun>();
  #opts: RunSupervisorOptions;
  #db: Database;

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = new Database(`${opts.config.dataDir}/events.db`);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Fork subprocess and return attemptId. Non-blocking. */
  fork(runId: string, threadId: string, specJson: string): { runId: string; attemptId: string; pid: number } {
    const attemptId = crypto.randomUUID();

    const child = spawn("bun", [this.#opts.runnerBin], {
      env: { ...process.env, AGENT_SPEC: specJson },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = child.pid!;

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

    const ac = new AbortController();
    child.on("exit", (code) => {
      this.#active.delete(runId);
      // finally block: update attempt.ended_at, derive run status from exit code
      const now = Date.now();
      this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, attemptId]);

      if (code === 0) {
        this.#db.run("UPDATE run SET status = 'succeeded', ended_at = ? WHERE run_id = ?", [now, runId]);
      } else if (ac.signal.aborted) {
        this.#db.run("UPDATE run SET status = 'aborted', ended_at = ? WHERE run_id = ?", [now, runId]);
      } else {
        this.#db.run("UPDATE run SET status = 'error', ended_at = ? WHERE run_id = ?", [now, runId]);
      }
    });

    this.#active.set(runId, { runId, attemptId, child, abortController: ac });

    // Write run + attempt ledger
    const now = Date.now();
    this.#db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [runId, threadId, now]);
    this.#db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [attemptId, runId, pid, now, now]);

    return { runId, attemptId, pid };
  }

  /** Send SIGTERM to subprocess; cancelGraceMs fallback to SIGKILL. */
  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;
    run.child.kill("SIGTERM");
    setTimeout(() => {
      if (run.child.exitCode === null) {
        run.child.kill("SIGKILL");
      }
    }, this.#opts.config.cancelGraceMs);
    return true;
  }

  /** On restart: discover live runs by heartbeat, mark stale ones interrupted. */
  async rediscover(eventSource: EventSource): Promise<void> {
    const rows = this.#db
      .query("SELECT * FROM attempt WHERE ended_at IS NULL")
      .all() as { attempt_id: string; run_id: string; pid: number | null; heartbeat_at: number | null }[];

    for (const row of rows) {
      const age = row.heartbeat_at ? Date.now() - row.heartbeat_at : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) {
        // Heartbeat fresh: run is alive (events continue via EventLog, no need to attach stdout)
        console.log(`[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`);
      } else {
        // Heartbeat stale: mark interrupted
        const now = Date.now();
        this.#db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [now, row.run_id]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, row.attempt_id]);
        console.log(`[supervisor] marked interrupted: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`);
      }
    }
  }
}
