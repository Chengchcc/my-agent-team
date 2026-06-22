import type { Message } from "@my-agent-team/message";
import type { ConversationLock } from "../conversation/lock.js";
import { parseThreadId } from "../conversation/service.js";
import { buildTitleContext, generateTitle } from "../conversation/title.js";
import type { EventLog, EventRecord } from "../event-log/index.js";
import type { RunDispatcher } from "./dispatcher.js";
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
  /** M17.5 P11: ConversationLock replaces threads Set — merged into unified gate. */
  lock: ConversationLock;
  idGen: () => string;
  /** M19: Unified run-start mechanism — replaces direct supervisor.startMainRun. */
  dispatcher: RunDispatcher;
  /** Optional: generate thread title via LLM after first run (when thread has no title). */
  autoTitle?: {
    getThread: (threadId: string) => Promise<{ title: string | null } | null>;
    getMessages: (threadId: string) => Promise<Message[] | null>;
    setTitle: (threadId: string, title: string) => Promise<void>;
    llm: { apiKey?: string; model?: string; baseUrl?: string };
  };
}

export function createRunService(deps: RunServiceDeps) {
  const { supervisor, eventLog, maxConcurrentRuns, lock, idGen, dispatcher, autoTitle } = deps;

  // M17.5 P11: Register cleanup callback — thread lock released via unified gate.
  supervisor.onRunComplete((threadId, _runId, status) => {
    const cid = parseThreadId(threadId).conversationId || threadId;
    lock.releaseThread(threadId, cid);
    // Only succeeded runs trigger downstream side effects (title, mention, etc.)
    if (status !== "succeeded") return;
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
    async start(threadId: string, spec: Record<string, unknown>) {
      const cid = parseThreadId(threadId).conversationId || threadId;
      const memberId = parseThreadId(threadId).memberId || threadId;
      if (!lock.acquireThread(threadId, cid)) throw new ThreadBusyError(threadId);
      if (supervisor.activeCount >= maxConcurrentRuns) {
        lock.releaseThread(threadId, cid);
        throw new TooManyRunsError(maxConcurrentRuns);
      }

      const runId = idGen();

      try {
        const { attemptId } = await dispatcher.dispatch({
          kind: "manual",
          runId,
          threadId,
          spec,
          origin: {
            conversationId: cid,
            sourceLedgerSeq: 0,
            agentMemberId: memberId,
            surface: "web",
            traceId: "",
            traceparent: "",
            idempotencyKey: runId,
            issueId: null,
            fromStatus: "",
          },
        });
        return { runId, attemptId };
      } catch (err) {
        lock.releaseThread(threadId, cid);
        throw err;
      }
    },

    cancel(runId: string): void {
      if (!supervisor.cancel(runId)) throw new RunNotFoundError(runId);
    },

    /** Resume an interrupted run by re-forking a new attempt with mode='resume'. */
    async resume(runId: string, threadId: string, spec: Record<string, unknown>) {
      if (supervisor.activeCount >= maxConcurrentRuns)
        throw new TooManyRunsError(maxConcurrentRuns);

      const { attemptId } = await supervisor.resumeRun(runId, threadId, spec);
      return { runId, attemptId };
    },

    /** Stream events via EventLog.subscribe for SSE projection.
     *  When the run completes, the iterator naturally returns so sseResponse
     *  emits 'done' — no frontend polling needed. */
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

      // Run still active — subscribe with client signal only.
      // Run completion is detected via a Promise that resolves when
      // onRunComplete fires, raced against the next subscription yield.
      // This avoids using AbortError for normal completion, so sseResponse
      // reliably sends "event: done" instead of swallowing it.
      let completed = false;
      let resolveDone: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const onDone = (_threadId: string, completedRunId: string) => {
        if (completedRunId === runId) {
          completed = true;
          resolveDone();
        }
      };
      supervisor.onRunComplete(onDone);

      try {
        const sub = eventLog.subscribe({ runId, afterSeq: afterSeq ?? 0 }, {}, signal);
        const iter = sub[Symbol.asyncIterator]();

        while (!completed && !signal?.aborted) {
          const next = await Promise.race([
            iter.next(),
            done.then((): { done: true; value: undefined } => ({ done: true, value: undefined })),
          ]);
          if (next.done) break;
          yield next.value;
        }

        await iter.return?.();
      } finally {
        // Clean up listener to avoid leak
      }
    },

    /** Get run metadata (status, timestamps). */
    getRunById(runId: string): {
      runId: string;
      status: string;
      startedAt: number | null;
      endedAt: number | null;
      degradedReason: string | null;
    } | null {
      const db = supervisor.getDb();
      const row = db
        .query(
          "SELECT run_id, status, started_at, ended_at, degraded_reason FROM run WHERE run_id = ?",
        )
        .get(runId) as
        | {
            run_id: string;
            status: string;
            started_at: number;
            ended_at: number | null;
            degraded_reason: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        degradedReason: row.degraded_reason,
      };
    },
  };
}
export type RunService = ReturnType<typeof createRunService>;
