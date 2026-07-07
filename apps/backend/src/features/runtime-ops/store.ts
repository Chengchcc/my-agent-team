import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import {
  controlPlaneEventSelectSchema,
  spanOriginSelectSchema,
  surfaceHealthSelectSchema,
} from "../../infra/db/schema.js";
import type {
  ControlPlaneEvent,
  ControlPlaneEventKind,
  SpanOriginInsert,
  SpanOriginRow,
  SurfaceHealthRow,
} from "./types.js";

export class RuntimeOpsStore {
  #d: ReturnType<typeof drizzle<typeof schema>>;
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
    this.#d = drizzle(db, { schema, casing: "snake_case" });
  }

  // ─── control_plane_event ───

  appendControlPlaneEvent(input: {
    spanId: string;
    attemptSeq?: number;
    kind: ControlPlaneEventKind;
    traceId?: string;
    payload?: Record<string, unknown>;
  }): number {
    const row = this.#d
      .insert(schema.controlPlaneEvent)
      .values({
        spanId: input.spanId,
        attemptSeq: input.attemptSeq ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        traceId: input.traceId ?? null,
        ts: Date.now(),
      })
      .returning({ seq: schema.controlPlaneEvent.seq })
      .get();
    return row!.seq;
  }

  getControlPlaneEvents(spanId: string): ControlPlaneEvent[] {
    return this.#d
      .select()
      .from(schema.controlPlaneEvent)
      .where(eq(schema.controlPlaneEvent.spanId, spanId))
      .orderBy(schema.controlPlaneEvent.seq)
      .all()
      .map((r) => controlPlaneEventSelectSchema.parse(r) as ControlPlaneEvent);
  }

  getControlPlaneEventsByTrace(traceId: string): ControlPlaneEvent[] {
    return this.#d
      .select()
      .from(schema.controlPlaneEvent)
      .where(eq(schema.controlPlaneEvent.traceId, traceId))
      .orderBy(schema.controlPlaneEvent.seq)
      .all()
      .map((r) => controlPlaneEventSelectSchema.parse(r) as ControlPlaneEvent);
  }

  // ─── run_origin ───

  insertSpanOrigin(row: SpanOriginInsert): void {
    // Invariant: issue-driven runs must carry a non-empty fromStatus
    if (row.issueId != null && row.fromStatus === "") {
      throw new Error(
        `run_origin with issueId must carry a non-empty fromStatus (spanId=${row.spanId})`,
      );
    }
    this.#d
      .insert(schema.spanOrigin)
      .values({
        spanId: row.spanId,
        conversationId: row.conversationId,
        sourceLedgerSeq: row.sourceLedgerSeq,
        agentMemberId: row.agentMemberId,
        surface: row.surface,
        idempotencyKey: row.idempotencyKey,
        issueId: row.issueId ?? null,
        cronJobId: row.cronJobId ?? null,
        fromStatus: row.fromStatus,
        originKind: row.originKind,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing()
      .run();
  }

  getSpanOrigin(spanId: string): SpanOriginRow | null {
    const row = this.#d
      .select()
      .from(schema.spanOrigin)
      .where(eq(schema.spanOrigin.spanId, spanId))
      .get();
    return row ? spanOriginSelectSchema.parse(row) : null;
  }

  getSpanOriginsByIssueId(issueId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.spanOrigin)
      .where(eq(schema.spanOrigin.issueId, issueId))
      .orderBy(schema.spanOrigin.createdAt)
      .all()
      .map((r) => spanOriginSelectSchema.parse(r));
  }

  getSpanOriginsByCronJobId(cronJobId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.spanOrigin)
      .where(eq(schema.spanOrigin.cronJobId, cronJobId))
      .orderBy(schema.spanOrigin.createdAt)
      .all()
      .map((r) => spanOriginSelectSchema.parse(r));
  }

  getRuns(runIds: string[]): Array<{
    spanId: string;
    sessionId: string;
    agentId: string;
    status: string;
    kind: string;
    parentSpanId: string | null;
    startedAt: number;
    endedAt: number | null;
  }> {
    if (runIds.length === 0) return [];
    return this.#d
      .select()
      .from(schema.span)
      .where(inArray(schema.span.spanId, runIds))
      .all()
      .map((r) => ({
        spanId: r.spanId,
        sessionId: r.sessionId,
        agentId: r.agentId,
        status: r.status,
        kind: r.kind,
        parentSpanId: r.parentSpanId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      }));
  }

  getRunBySpanId(spanId: string): {
    spanId: string;
    sessionId: string;
    agentId: string;
    status: string;
    kind: string;
    parentSpanId: string | null;
    startedAt: number;
    endedAt: number | null;
  } | null {
    const row = this.#d.select().from(schema.span).where(eq(schema.span.spanId, spanId)).get();
    if (!row) return null;
    return {
      spanId: row.spanId,
      sessionId: row.sessionId,
      agentId: row.agentId,
      status: row.status,
      kind: row.kind,
      parentSpanId: row.parentSpanId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    };
  }

  getSessionIdBySpanId(spanId: string): string | null {
    const row = this.#d
      .select({ sessionId: schema.span.sessionId })
      .from(schema.span)
      .where(eq(schema.span.spanId, spanId))
      .get();
    return row?.sessionId ?? null;
  }

  getAttemptsBySpanId(spanId: string): Array<{
    seq: number;
    startedAt: number;
    endedAt: number | null;
  }> {
    return this.#d
      .select({
        seq: schema.attempt.seq,
        startedAt: schema.attempt.startedAt,
        endedAt: schema.attempt.endedAt,
      })
      .from(schema.attempt)
      .where(eq(schema.attempt.spanId, spanId))
      .orderBy(desc(schema.attempt.seq))
      .all();
  }

  getLatestAttempt(spanId: string): {
    seq: number;
    startedAt: number;
    endedAt: number | null;
  } | null {
    return (
      this.#d
        .select({
          seq: schema.attempt.seq,
          startedAt: schema.attempt.startedAt,
          endedAt: schema.attempt.endedAt,
        })
        .from(schema.attempt)
        .where(eq(schema.attempt.spanId, spanId))
        .orderBy(desc(schema.attempt.seq))
        .limit(1)
        .get() ?? null
    );
  }

  getSpansBySession(sessionId: string): Array<{
    spanId: string;
    status: string;
    kind: string;
    agentId: string;
    startedAt: number;
    endedAt: number | null;
  }> {
    return this.#d
      .select({
        spanId: schema.span.spanId,
        status: schema.span.status,
        kind: schema.span.kind,
        agentId: schema.span.agentId,
        startedAt: schema.span.startedAt,
        endedAt: schema.span.endedAt,
      })
      .from(schema.span)
      .where(eq(schema.span.sessionId, sessionId))
      .orderBy(desc(schema.span.startedAt))
      .all();
  }

  /** Expose the raw bun:sqlite connection for dynamic SQL (buildRunQuery, listSessions aggregate). */
  getRawDb(): Database {
    return this.#db;
  }

  listSpanOrigins(): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.spanOrigin)
      .orderBy(desc(schema.spanOrigin.createdAt))
      .all()
      .map((r) => spanOriginSelectSchema.parse(r));
  }

  // ─── surface_health ───

  upsertSurfaceHealth(input: {
    agentId: string;
    surface: string;
    status: string;
    payload: Record<string, unknown>;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#d
      .insert(schema.surfaceHealth)
      .values({
        agentId: input.agentId,
        surface: input.surface,
        status: input.status,
        lastSeenAt: now,
        payload: JSON.stringify(input.payload),
        lastError: input.lastError ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.surfaceHealth.agentId, schema.surfaceHealth.surface],
        set: {
          status: input.status,
          lastSeenAt: now,
          payload: JSON.stringify(input.payload),
          lastError: input.lastError ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  getSurfaceHealth(agentId: string, surface: string): SurfaceHealthRow | undefined {
    const row = this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(
        and(eq(schema.surfaceHealth.agentId, agentId), eq(schema.surfaceHealth.surface, surface)),
      )
      .get();
    return row ? surfaceHealthSelectSchema.parse(row) : undefined;
  }

  getSurfaceHealthsForAgent(agentId: string): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(eq(schema.surfaceHealth.agentId, agentId))
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }

  listSurfaceHealths(): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .orderBy(schema.surfaceHealth.agentId, schema.surfaceHealth.surface)
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }
}
