import type { EventLog } from "@my-agent-team/event-log";
import type { RunSupervisor } from "./supervisor.js";

export class ThreadBusyError extends Error {
  constructor(threadId: string) {
    super(`Thread busy: ${threadId}`);
    this.name = "ThreadBusyError";
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`Run not found: ${id}`);
    this.name = "RunNotFoundError";
  }
}

export class TooManyRunsError extends Error {
  constructor(max: number) {
    super(`Too many concurrent runs (max: ${max})`);
    this.name = "TooManyRunsError";
  }
}

export class RunNotInterruptedError extends Error {
  constructor(id: string) {
    super(`Run is not in interrupted state: ${id}`);
    this.name = "RunNotInterruptedError";
  }
}

export interface RunServiceDeps {
  supervisor: RunSupervisor;
  eventLog: EventLog;
  maxConcurrentRuns: number;
  threads: Set<string>;
  idGen: () => string;
}

export function createRunService(deps: RunServiceDeps) {
  const { supervisor, eventLog, maxConcurrentRuns, threads, idGen } = deps;

  // Fix B: Register cleanup callback so thread lock is released on run completion
  supervisor.onRunComplete((threadId, _runId) => {
    threads.delete(threadId);
  });

  return {
    /** Fork subprocess + write ledger. Returns 202 payload immediately. */
    start(threadId: string, _input: string, specJson: string) {
      if (threads.has(threadId)) throw new ThreadBusyError(threadId);
      if (supervisor.activeCount >= maxConcurrentRuns) throw new TooManyRunsError(maxConcurrentRuns);

      const runId = idGen();
      threads.add(threadId);

      try {
        const { attemptId } = supervisor.fork(runId, threadId, specJson);
        return { runId, attemptId };
      } catch (err) {
        threads.delete(threadId);
        throw err;
      }
    },

    cancel(runId: string): void {
      if (!supervisor.cancel(runId)) throw new RunNotFoundError(runId);
    },

    /** Resume an interrupted run by re-forking a new attempt with mode='resume'. */
    resume(runId: string, threadId: string, specJson: string) {
      if (supervisor.activeCount >= maxConcurrentRuns) throw new TooManyRunsError(maxConcurrentRuns);

      const { attemptId } = supervisor.fork(runId, threadId, specJson);
      return { runId, attemptId };
    },

    /** Stream events via EventLog.subscribe for SSE projection. */
    eventStream(runId: string, afterSeq?: number, signal?: AbortSignal) {
      return eventLog.subscribe({ runId, afterSeq: afterSeq ?? 0 }, {}, signal);
    },

    /** M13: Stream ephemeral text_delta events via supervisor fan-out. Never hits EventLog. */
    deltaStream(runId: string): ReadableStream {
      return supervisor.subscribeDelta(runId);
    },

    /** D12: Get active run for a thread, or null. */
    getCurrentRun(threadId: string): { runId: string; status: string } | null {
      const db = supervisor.getDb();
      const row = db
        .query(
          "SELECT run_id, status FROM run WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(threadId) as { run_id: string; status: string } | undefined;
      if (!row) return null;
      return { runId: row.run_id, status: row.status };
    },

    /** Get run metadata (status, timestamps). */
    getRunById(runId: string): { runId: string; status: string; startedAt: number | null; endedAt: number | null } | null {
      const db = supervisor.getDb();
      const row = db.query("SELECT run_id, status, started_at, ended_at FROM run WHERE run_id = ?").get(runId) as
        | { run_id: string; status: string; started_at: number; ended_at: number | null }
        | undefined;
      if (!row) return null;
      return { runId: row.run_id, status: row.status, startedAt: row.started_at, endedAt: row.ended_at };
    },
  };
}
