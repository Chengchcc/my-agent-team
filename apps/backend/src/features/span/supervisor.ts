import type { Database } from "bun:sqlite";
import type { MessageRevision } from "@my-agent-team/message";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { BackendConfig } from "../../config.js";
import * as schema from "../../infra/db/schema.js";
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
}

export class SpanSupervisor {
  #active = new Map<string, RunSession>();
  #opts: SpanSupervisorOptions;
  #db: Database;
  #d: ReturnType<typeof drizzle<typeof schema>>;
  #onRunComplete: Array<
    (
      sessionId: string,
      spanId: string,
      status: string,
      kind: string,
      errorMessage?: string,
    ) => void | Promise<void>
  > = [];
  #onRunMessage: Array<
    (sessionId: string, spanId: string, revision: MessageRevision, kind: string) => Promise<void>
  > = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;

  constructor(opts: SpanSupervisorOptions) {
    this.#opts = opts;
    this.#db = opts.db;
    this.#d = drizzle(opts.db, { schema, casing: "snake_case" });
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
  getDrizzle(): ReturnType<typeof drizzle<typeof schema>> {
    return this.#d;
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
    const orphans = this.#d
      .select({
        spanId: schema.attempt.spanId,
        seq: schema.attempt.seq,
        sessionId: schema.run.sessionId,
        kind: schema.run.kind,
      })
      .from(schema.attempt)
      .innerJoin(schema.run, eq(schema.attempt.spanId, schema.run.spanId))
      .where(and(isNull(schema.attempt.endedAt), isNull(schema.run.endedAt)))
      .all();

    let reaped = false;
    for (const row of orphans) {
      // Skip if session is still running in this process
      if (this.#active.has(row.spanId)) continue;

      const finalized = await this.#finalizeRun(row.spanId, row.seq, "interrupted");
      if (!finalized) continue;
      reaped = true;

      // Dispose AgentSession via callback (prevents zombie writes to ledger)
      this.#opts.onReap?.(row.spanId, row.sessionId);

      // Fire completion listeners
      const kind = row.kind === "reflect" ? "reflect" : "main";
      for (const listener of this.#onRunComplete) {
        try {
          await listener(row.sessionId, row.spanId, "interrupted", kind);
        } catch (err) {
          this.#markProjectionDegraded(row.spanId, row.seq, err);
        }
      }
    }
    return reaped;
  }

  // ─── Run/attempt lifecycle ─────────────────────────

  /** CAS finalize: first writer wins. Returns true if this call finalized the run. */
  async #finalizeRun(spanId: string, attemptSeq: number | null, status: string): Promise<boolean> {
    const now = Date.now();
    const updated = await this.#d.transaction((tx) => {
      const rows = tx
        .update(schema.run)
        .set({ status, endedAt: now })
        .where(and(eq(schema.run.spanId, spanId), isNull(schema.run.endedAt)))
        .returning({ spanId: schema.run.spanId })
        .all();
      if (rows.length > 0 && attemptSeq != null) {
        tx.update(schema.attempt)
          .set({ endedAt: now })
          .where(
            and(
              eq(schema.attempt.spanId, spanId),
              eq(schema.attempt.seq, attemptSeq),
              isNull(schema.attempt.endedAt),
            ),
          )
          .run();
      }
      return rows;
    });
    return updated.length > 0;
  }

  #markProjectionDegraded(spanId: string, attemptSeq: number | null, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.#d
      .update(schema.run)
      .set({ degradedReason: reason })
      .where(and(eq(schema.run.spanId, spanId), isNull(schema.run.degradedReason)))
      .run();
    this.#opts.opsStore.appendControlPlaneEvent({
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

    const seq = await this.#d.transaction(async (tx) => {
      await tx
        .insert(schema.run)
        .values({
          spanId,
          sessionId,
          status: "running",
          startedAt: now,
        })
        .run();

      const rows = tx
        .select({ maxSeq: schema.attempt.seq })
        .from(schema.attempt)
        .where(eq(schema.attempt.spanId, spanId))
        .all();
      const maxSeq = rows.reduce((max, r) => Math.max(max, r.maxSeq ?? 0), 0);
      const nextSeq = maxSeq + 1;

      await tx
        .insert(schema.attempt)
        .values({
          spanId,
          seq: nextSeq,
          startedAt: now,
        })
        .run();

      return nextSeq;
    });

    const attemptSeq = seq;

    const session: RunSession = {
      spanId,
      attemptSeq,
      sessionId: sessionId,
      agentId,
      kind: "main",
      abortController: new AbortController(),
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
    fn: (
      sessionId: string,
      spanId: string,
      status: string,
      kind: string,
      errorMessage?: string,
    ) => void | Promise<void>,
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
    errorMessage?: string,
  ): Promise<void> {
    await this.#finalizeRun(spanId, attemptSeq, status);
    this.#active.delete(spanId);
    for (const listener of this.#onRunComplete) {
      try {
        await listener(sessionId, spanId, status, kind, errorMessage);
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
