import type { EventLog } from "@my-agent-team/event-log";
import type { RunSupervisor } from "./supervisor";

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

  return {
    /** Fork subprocess + write ledger. Returns 202 payload immediately. */
    start(threadId: string, input: string, specJson: string) {
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

    /** Resume an interrupted run with a new attempt. */
    resume(runId: string, approved: boolean, message?: string) {
      // Check that the run exists and is in 'interrupted' state
      // (RunSupervisor handles the re-fork)
      // For now, return a placeholder — the HTTP handler will build the spec and call supervisor.fork
      return { runId };
    },

    /** Stream events via EventLog.subscribe for SSE projection. */
    eventStream(runId: string, afterSeq?: number, signal?: AbortSignal) {
      return eventLog.subscribe({ runId, afterSeq: afterSeq ?? 0 }, {}, signal);
    },
  };
}
