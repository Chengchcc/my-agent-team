import type { AgentEvent } from "@my-agent-team/framework";
import type { RunRow } from "./domain.js";

export class ThreadBusyError extends Error {
  constructor(threadId: string) {
    super(`Thread busy: ${threadId}`);
    this.name = "ThreadBusyError";
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`Run not found or not running: ${id}`);
    this.name = "RunNotFoundError";
  }
}

export interface RunServiceDeps {
  port: {
    create(input: {
      id: string;
      threadId: string;
      input: string;
      status: string;
      startedAt: number;
    }): RunRow;
    findById(id: string): RunRow | null;
    updateStatus(
      id: string,
      status: string,
      errorMessage?: string,
      endedAt?: number,
    ): RunRow | null;
  };
  idGen: () => string;
  runner: (spec: unknown, signal: AbortSignal) => AsyncIterable<AgentEvent>;
  threads: Set<string>;
  abortMap: Map<string, AbortController>;
  threadSvc: { touchLastRun(id: string): void };
}

export function createRunService(deps: RunServiceDeps) {
  const { port, idGen, runner, threads, abortMap, threadSvc } = deps;

  return {
    start(threadId: string, input: string, spec?: unknown): AsyncIterable<AgentEvent> {
      if (threads.has(threadId)) throw new ThreadBusyError(threadId);
      threads.add(threadId);

      const runId = idGen();
      const ac = new AbortController();
      abortMap.set(runId, ac);

      try {
        port.create({ id: runId, threadId, input, status: "running", startedAt: Date.now() });
      } catch (err) {
        threads.delete(threadId);
        abortMap.delete(runId);
        throw err;
      }

      return startRunInner(runId, threadId, spec, ac);
    },

    cancel(runId: string): void {
      const ac = abortMap.get(runId);
      if (!ac) throw new RunNotFoundError(runId);
      ac.abort();
      abortMap.delete(runId);
    },
  };

  async function* startRunInner(
    runId: string,
    threadId: string,
    spec: unknown,
    ac: AbortController,
  ): AsyncIterable<AgentEvent> {
    try {
      let status: RunRow["status"] = "completed";
      let errorMessage: string | null = null;

      try {
        for await (const ev of runner(spec ?? {}, ac.signal)) {
          yield ev;
          if (ev.type === "error") {
            status = "error";
            errorMessage = ev.payload.message;
          }
        }
        // H3: runner completed without throwing, but might have been aborted via signal
        if (ac.signal.aborted) status = "aborted";
      } catch (err) {
        status = ac.signal.aborted ? "aborted" : "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        if (status === "error") {
          yield { type: "error", payload: { message: errorMessage } };
        }
      }

      port.updateStatus(runId, status, errorMessage ?? undefined, Date.now());
      threadSvc.touchLastRun(threadId);
    } finally {
      threads.delete(threadId);
      abortMap.delete(runId);
    }
  }
}
