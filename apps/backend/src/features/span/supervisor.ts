import type { Database } from "bun:sqlite";
import type { MessageRevision } from "@my-agent-team/message";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";

import type { BackendConfig } from "../../config.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";

export interface SpanSupervisorOptions {
  config: BackendConfig;
  opsStore: RuntimeOpsStore;
  tracer: RuntimeTracer;
  db: Database;
  /** Called when reaper harvests a stale run — allows session cleanup. */
  onReap?: (spanId: string, sessionId: string) => void;
}

export interface RunSession {
  spanId: string;
  attemptSeq: number;
  sessionId: string;
  agentId: string;
  kind: "main" | "reflect";
  abortController: AbortController;
  /** @deprecated always "attached" — AgentSession runs in-process */
  transportKind: "attached" | "noop" | "detached";
}

export class SpanSupervisor {
  #active = new Map<string, RunSession>();
  #opts: SpanSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<
    (sessionId: string, spanId: string, status: string, kind: string) => void | Promise<void>
  > = [];
  #onRunMessage: Array<
    (sessionId: string, spanId: string, revision: MessageRevision, kind: string) => Promise<void>
  > = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;

  constructor(opts: SpanSupervisorOptions) {
    this.#opts = opts;
    this.#db = opts.db;
    // WAL + schema migrations are managed by openDb() in main.ts (S1 storage convergence).
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
        `SELECT a.span_id, a.seq, r.session_id, r.kind
         FROM attempt a JOIN run r ON a.span_id = r.span_id
         WHERE a.ended_at IS NULL AND r.ended_at IS NULL`,
      )
      .all() as Array<{
      span_id: string;
      seq: number;
      session_id: string;
      kind: string;
    }>;

    let reaped = false;
    for (const row of orphans) {
      // Skip if session is still running in this process
      if (this.#active.has(row.span_id)) continue;

      const finalized = this.#finalizeRun(row.span_id, row.seq, "interrupted");
      if (!finalized) continue;
      reaped = true;

      // Dispose AgentSession via callback (prevents zombie writes to ledger)
      this.#opts.onReap?.(row.span_id, row.session_id);

      // Fire completion listeners
      const kind = row.kind === "reflect" ? "reflect" : "main";
      for (const listener of this.#onRunComplete) {
        try {
          await listener(row.session_id, row.span_id, "interrupted", kind);
        } catch (err) {
          this.#markProjectionDegraded(row.span_id, row.seq, err);
        }
      }
    }
    return reaped;
  }

  // ─── Run/attempt lifecycle ─────────────────────────

  /** CAS finalize: first writer wins. Returns true if this call finalized the run. */
  #finalizeRun(spanId: string, attemptSeq: number | null, status: string): boolean {
    const now = Date.now();
    const result = this.#db.transaction(() => {
      const r = this.#db.run(
        "UPDATE run SET status = ?, ended_at = ? WHERE span_id = ? AND ended_at IS NULL",
        [status, now, spanId],
      );
      if (attemptSeq != null) {
        this.#db.run(
          "UPDATE attempt SET ended_at = ? WHERE span_id = ? AND seq = ? AND ended_at IS NULL",
          [now, spanId, attemptSeq],
        );
      }
      return r.changes;
    })();
    return result > 0;
  }

  #markProjectionDegraded(spanId: string, attemptSeq: number | null, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.#db.run(
      "UPDATE run SET degraded_reason = ? WHERE span_id = ? AND degraded_reason IS NULL",
      [reason, spanId],
    );
    this.#opts.opsStore.appendRunEvent({
      spanId,
      attemptSeq: attemptSeq ?? undefined,
      kind: "projection_degraded",
      payload: { reason },
    });
    console.error(`[supervisor] run ${spanId} marked DEGRADED: ${reason}`);
  }

  // ─── Public: start / cancel ────────────────────────

  async startMainRun(
    spanId: string,
    sessionId: string,
    spec: Record<string, unknown>,
    _opts?: Record<string, unknown>,
  ): Promise<{ spanId: string; attemptSeq: number }> {
    const agentId = (spec.agentId as string) ?? sessionId;
    const now = Date.now();

    let seq = 1;
    this.#db.transaction(() => {
      this.#db.run(
        "INSERT INTO run (span_id, session_id, status, started_at) VALUES (?, ?, 'running', ?)",
        [spanId, sessionId, now],
      );
      const row = this.#db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attempt WHERE span_id = ?")
        .get(spanId) as { n: number } | undefined;
      seq = row?.n ?? 1;
      this.#db.run("INSERT INTO attempt (span_id, seq, started_at) VALUES (?, ?, ?)", [
        spanId,
        seq,
        now,
      ]);
    })();

    const attemptSeq = seq;

    const session: RunSession = {
      spanId,
      attemptSeq,
      sessionId: sessionId,
      agentId,
      kind: "main",
      abortController: new AbortController(),
      transportKind: "attached",
    };
    this.#active.set(spanId, session);
    return { spanId, attemptSeq };
  }

  cancel(spanId: string): boolean {
    const session = this.#active.get(spanId);
    if (!session) return false;
    session.abortController.abort();
    return true;
  }

  // ─── Public: event callbacks ───────────────────────

  onRunComplete(
    fn: (sessionId: string, spanId: string, status: string, kind: string) => void | Promise<void>,
  ): void {
    this.#onRunComplete.push(fn);
  }

  onRunMessage(
    fn: (
      sessionId: string,
      spanId: string,
      revision: MessageRevision,
      kind: string,
    ) => Promise<void>,
  ): void {
    this.#onRunMessage.push(fn);
  }

  /** Fire a message event directly (called by AgentSession subscriber).
   *  Replaces the old transport → supervisor message routing. */
  notifyRunMessage(
    sessionId: string,
    spanId: string,
    revision: MessageRevision,
    kind: string,
  ): void {
    for (const fn of this.#onRunMessage) {
      void fn(sessionId, spanId, revision, kind).catch((err) =>
        console.error(`[supervisor] onRunMessage error:`, err),
      );
    }
  }

  /** Fire a run completion event directly (called by AgentSession subscriber).
   *  Finalizes the run row and triggers onRunComplete listeners. */
  async notifyRunComplete(
    sessionId: string,
    spanId: string,
    status: string,
    kind: string,
    attemptSeq: number | null = null,
  ): Promise<void> {
    this.#finalizeRun(spanId, attemptSeq, status);
    this.#active.delete(spanId);
    for (const listener of this.#onRunComplete) {
      try {
        await listener(sessionId, spanId, status, kind);
      } catch (err) {
        this.#markProjectionDegraded(spanId, attemptSeq, err);
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
