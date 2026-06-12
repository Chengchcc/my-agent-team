import type { Message } from "@my-agent-team/core";
import type { EventLog, EventRecord } from "@my-agent-team/event-log";
import type { RunSupervisor } from "./supervisor.js";

/** Merge multiple AbortSignals — aborts when any of them fires. */
function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => !!s);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const s of defined) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return ctrl.signal;
}

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
  /** Optional: generate thread title via LLM after first run (when thread has no title). */
  autoTitle?: {
    getThread: (threadId: string) => Promise<{ title: string | null } | null>;
    getMessages: (threadId: string) => Promise<Message[] | null>;
    setTitle: (threadId: string, title: string) => Promise<void>;
    llm: { apiKey?: string; model?: string; baseUrl?: string };
  };
}

export function createRunService(deps: RunServiceDeps) {
  const { supervisor, eventLog, maxConcurrentRuns, threads, idGen, autoTitle } = deps;

  // Fix B: Register cleanup callback so thread lock is released on run completion
  supervisor.onRunComplete((threadId, _runId) => {
    threads.delete(threadId);
    if (autoTitle) {
      // fire-and-forget: title generation failure is non-fatal
      void (async () => {
        try {
          const t = await autoTitle.getThread(threadId);
          if (!t || (t.title && t.title.trim().length > 0)) return;
          const msgs = await autoTitle.getMessages(threadId);
          if (!msgs) return;
          // Require at least 2 user + 2 assistant messages (4 total) for
          // accurate title summarization. Fewer rounds = not enough context.
          const userAssist = msgs.filter((m) => m.role === "user" || m.role === "assistant");
          if (userAssist.length < 4) return;
          const { buildTitleContext, generateTitle } = await import("../conversation/title.js");
          const ctx = buildTitleContext(msgs);
          const title = await generateTitle(autoTitle.llm, ctx);
          if (title) await autoTitle.setTitle(threadId, title);
        } catch {
          /* best-effort */
        }
      })();
    }
  });

  return {
    /** Fork subprocess + write ledger. Returns 202 payload immediately. */
    start(threadId: string, _input: string, spec: Record<string, unknown>) {
      if (threads.has(threadId)) throw new ThreadBusyError(threadId);
      if (supervisor.activeCount >= maxConcurrentRuns)
        throw new TooManyRunsError(maxConcurrentRuns);

      const runId = idGen();
      threads.add(threadId);

      try {
        const { attemptId } = supervisor.start(runId, threadId, spec);
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
    resume(runId: string, threadId: string, spec: Record<string, unknown>) {
      if (supervisor.activeCount >= maxConcurrentRuns)
        throw new TooManyRunsError(maxConcurrentRuns);

      const { attemptId } = supervisor.start(runId, threadId, spec);
      return { runId, attemptId };
    },

    /** Stream events via EventLog.subscribe for SSE projection.
     *  When the run completes, the subscription is aborted so sseResponse
     *  naturally emits 'done' — no frontend polling needed. */
    async *eventStream(
      runId: string,
      afterSeq?: number,
      signal?: AbortSignal,
    ): AsyncIterable<EventRecord> {
      // If run already finished, replay remaining events then stop
      const db = supervisor.getDb();
      const meta = db
        .query("SELECT run_id, status, started_at, ended_at FROM run WHERE run_id = ?")
        .get(runId) as
        | { run_id: string; status: string; started_at: number; ended_at: number | null }
        | undefined;
      if (meta && meta.ended_at !== null) {
        const records = await eventLog.read({
          runId,
          afterSeq: afterSeq ?? 0,
        });
        for (const rec of records) {
          if (signal?.aborted) return;
          yield rec;
        }
        return; // iterable ends → sseResponse emits done
      }

      // Run still active — merge request signal with run-complete signal
      const doneCtrl = new AbortController();
      const merged = mergeSignals(signal, doneCtrl.signal);

      // Register one-shot callback: when run completes, abort subscription
      const onDone = (_threadId: string, completedRunId: string) => {
        if (completedRunId === runId) {
          doneCtrl.abort();
        }
      };
      supervisor.onRunComplete(onDone);

      try {
        for await (const rec of eventLog.subscribe(
          { runId, afterSeq: afterSeq ?? 0 },
          {},
          merged,
        )) {
          yield rec;
        }
      } finally {
        // Clean up listener to avoid leak
        // (supervisor doesn't have removeListener, but callbacks are cheap;
        //  the abort controller prevents double-completion)
      }
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
    getRunById(
      runId: string,
    ): { runId: string; status: string; startedAt: number | null; endedAt: number | null } | null {
      const db = supervisor.getDb();
      const row = db
        .query("SELECT run_id, status, started_at, ended_at FROM run WHERE run_id = ?")
        .get(runId) as
        | { run_id: string; status: string; started_at: number; ended_at: number | null }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      };
    },
  };
}
export type RunService = ReturnType<typeof createRunService>;
