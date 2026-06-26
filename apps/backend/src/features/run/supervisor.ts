import type { Database } from "bun:sqlite";
import type { AgentEvent } from "@my-agent-team/framework";
import type { MessageRevision } from "@my-agent-team/message";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";

import type { BackendConfig } from "../../config.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { runEventsDbMigrations } from "./events-db-migrations.js";

export interface RunSupervisorOptions {
  config: BackendConfig;
  opsStore: RuntimeOpsStore;
  tracer: RuntimeTracer;
  db: Database;
  /** Called when reaper harvests a stale run — allows session cleanup. */
  onReap?: (runId: string) => void;
}

export interface RunSession {
  runId: string;
  attemptSeq: number;
  sessionId: string;
  agentId: string;
  kind: "main" | "reflect";
  abortController: AbortController;
  /** @deprecated always "attached" — AgentSession runs in-process */
  transportKind: "attached" | "noop" | "detached";
}

export class RunSupervisor {
  #active = new Map<string, RunSession>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<
    (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>
  > = [];
  #onRunEvent: Array<
    (threadId: string, runId: string, event: AgentEvent, kind: string) => void | Promise<void>
  > = [];
  #onRunMessage: Array<
    (threadId: string, runId: string, revision: MessageRevision, kind: string) => Promise<void>
  > = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = opts.db;
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    runEventsDbMigrations(this.#db);
    this.#startReaper();
  }

  get activeCount(): number {
    return this.#active.size;
  }

  getActive(): ReadonlyMap<string, RunSession> {
    return this.#active;
  }

  getDb(): Database {
    return this.#db;
  }

  // ─── Reaper ─────────────────────────────────────────

  #startReaper(): void {
    const interval =
      this.#opts.config.reaperIntervalMs > 0
        ? this.#opts.config.reaperIntervalMs
        : Math.min(this.#opts.config.heartbeatTimeoutMs / 2, 30_000);
    this.#reaperTimer = setInterval(() => {
      if (this.#reaping) return;
      this.#reaping = true;
      this.#reapStaleRuns()
        .catch((err) =>
          console.error(
            `[supervisor] reaper error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => {
          this.#reaping = false;
        });
    }, interval);
  }

  async #reapStaleRuns(): Promise<boolean> {
    // AgentSession runs in-process — a run is "stale" only if it has
    // DB state = running but NO active session in memory (process restart).
    // Long-running agent sessions are NOT stale — only orphaned DB rows.
    const orphans = this.#db
      .query(
        `SELECT a.run_id, a.seq, r.session_id, r.kind
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL AND r.ended_at IS NULL`,
      )
      .all() as Array<{
      run_id: string;
      seq: number;
      session_id: string;
      kind: string;
    }>;

    let reaped = false;
    for (const row of orphans) {
      // Skip if session is still running in this process
      if (this.#active.has(row.run_id)) continue;

      const finalized = this.#finalizeRun(row.run_id, row.seq, "interrupted");
      if (!finalized) continue;
      reaped = true;

      // Dispose AgentSession via callback (prevents zombie writes to ledger)
      this.#opts.onReap?.(row.run_id);

      // Fire completion listeners
      const kind = row.kind === "reflect" ? "reflect" : "main";
      for (const listener of this.#onRunComplete) {
        try {
          await listener(row.session_id, row.run_id, "interrupted", kind);
        } catch (err) {
          this.#markProjectionDegraded(row.run_id, row.seq, err);
        }
      }
    }
    return reaped;
  }

  // ─── Run/attempt lifecycle ─────────────────────────

  /** CAS finalize: first writer wins. Returns true if this call finalized the run. */
  #finalizeRun(runId: string, attemptSeq: number | null, status: string): boolean {
    const now = Date.now();
    const result = this.#db.transaction(() => {
      const r = this.#db.run(
        "UPDATE run SET status = ?, ended_at = ? WHERE run_id = ? AND ended_at IS NULL",
        [status, now, runId],
      );
      if (attemptSeq != null) {
        this.#db.run(
          "UPDATE attempt SET ended_at = ? WHERE run_id = ? AND seq = ? AND ended_at IS NULL",
          [now, runId, attemptSeq],
        );
      }
      return r.changes;
    })();
    return result > 0;
  }

  #markProjectionDegraded(runId: string, attemptSeq: number | null, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.#db.run(
      "UPDATE run SET degraded_reason = ? WHERE run_id = ? AND degraded_reason IS NULL",
      [reason, runId],
    );
    this.#opts.opsStore.appendRunEvent({
      runId,
      attemptSeq: attemptSeq ?? undefined,
      kind: "projection_degraded",
      payload: { reason },
    });
    console.error(`[supervisor] run ${runId} marked DEGRADED: ${reason}`);
  }

  // ─── Public: start / cancel ────────────────────────

  async startMainRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
    _opts?: Record<string, unknown>,
  ): Promise<{ runId: string; attemptSeq: number }> {
    const agentId = (spec.agentId as string) ?? threadId;
    const now = Date.now();

    let seq = 1;
    this.#db.transaction(() => {
      this.#db.run(
        "INSERT INTO run (run_id, session_id, status, started_at) VALUES (?, ?, 'running', ?)",
        [runId, threadId, now],
      );
      const row = this.#db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attempt WHERE run_id = ?")
        .get(runId) as { n: number } | undefined;
      seq = row?.n ?? 1;
      this.#db.run("INSERT INTO attempt (run_id, seq, started_at) VALUES (?, ?, ?)", [
        runId,
        seq,
        now,
      ]);
    })();

    const attemptSeq = seq;

    const session: RunSession = {
      runId,
      attemptSeq,
      sessionId: threadId,
      agentId,
      kind: "main",
      abortController: new AbortController(),
      transportKind: "attached",
    };
    this.#active.set(runId, session);
    return { runId, attemptSeq };
  }

  cancel(runId: string): boolean {
    const session = this.#active.get(runId);
    if (!session) return false;
    session.abortController.abort();
    return true;
  }

  // ─── Public: event callbacks ───────────────────────

  onRunComplete(
    fn: (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>,
  ): void {
    this.#onRunComplete.push(fn);
  }

  onRunMessage(
    fn: (threadId: string, runId: string, revision: MessageRevision, kind: string) => Promise<void>,
  ): void {
    this.#onRunMessage.push(fn);
  }

  onRunEvent(
    fn: (threadId: string, runId: string, event: AgentEvent, kind: string) => void | Promise<void>,
  ): void {
    this.#onRunEvent.push(fn);
  }

  /** Fire a message event directly (called by AgentSession subscriber).
   *  Replaces the old transport → supervisor message routing. */
  notifyRunMessage(threadId: string, runId: string, revision: MessageRevision, kind: string): void {
    for (const fn of this.#onRunMessage) {
      void fn(threadId, runId, revision, kind).catch((err) =>
        console.error(`[supervisor] onRunMessage error:`, err),
      );
    }
  }

  /** Fire a run completion event directly (called by AgentSession subscriber).
   *  Finalizes the run row and triggers onRunComplete listeners. */
  async notifyRunComplete(
    threadId: string,
    runId: string,
    status: string,
    kind: string,
    attemptSeq: number | null = null,
  ): Promise<void> {
    this.#finalizeRun(runId, attemptSeq, status);
    this.#active.delete(runId);
    for (const listener of this.#onRunComplete) {
      try {
        await listener(threadId, runId, status, kind);
      } catch (err) {
        this.#markProjectionDegraded(runId, attemptSeq, err);
      }
    }
  }

  // ─── Shutdown ──────────────────────────────────────

  cancelAll(): void {
    for (const session of this.#active.values()) {
      session.abortController.abort();
    }
  }

  async dispose(): Promise<void> {
    if (this.#reaperTimer) clearInterval(this.#reaperTimer);
    while (this.#reaping) await new Promise((r) => setTimeout(r, 10));
    this.#active.clear();
  }
}
