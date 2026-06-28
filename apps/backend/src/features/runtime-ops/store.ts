import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import {
  controlPlaneEventSelectSchema,
  issueEventSelectSchema,
  runOriginSelectSchema,
  surfaceHealthSelectSchema,
} from "../../infra/db/schema.js";
import type {
  ControlPlaneEvent,
  ControlPlaneEventKind,
  IssueEvent,
  IssueEventKind,
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

  // ─── issue_event (M18.7) ───

  appendIssueEvent(input: {
    issueId: string;
    kind: IssueEventKind;
    payload?: Record<string, unknown>;
  }): number {
    const row = this.#d
      .insert(schema.issueEvent)
      .values({
        issueId: input.issueId,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        ts: Date.now(),
      })
      .returning({ seq: schema.issueEvent.seq })
      .get();
    return row!.seq;
  }

  getIssueEvents(issueId: string, afterSeq = 0): IssueEvent[] {
    return this.#d
      .select()
      .from(schema.issueEvent)
      .where(and(eq(schema.issueEvent.issueId, issueId), gt(schema.issueEvent.seq, afterSeq)))
      .orderBy(schema.issueEvent.seq)
      .all()
      .map((r) => issueEventSelectSchema.parse(r) as IssueEvent);
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
      .insert(schema.runOrigin)
      .values({
        spanId: row.spanId,
        conversationId: row.conversationId,
        sourceLedgerSeq: row.sourceLedgerSeq,
        agentMemberId: row.agentMemberId,
        surface: row.surface,
        traceId: row.traceId,
        traceparent: row.traceparent,
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
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.spanId, spanId))
      .get();
    return row ? runOriginSelectSchema.parse(row) : null;
  }

  getSpanOriginsByIssueId(issueId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.issueId, issueId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map((r) => runOriginSelectSchema.parse(r));
  }

  getSpanOriginsByCronJobId(cronJobId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.cronJobId, cronJobId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map((r) => runOriginSelectSchema.parse(r));
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
      .from(schema.run)
      .where(inArray(schema.run.spanId, runIds))
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
    const row = this.#d.select().from(schema.run).where(eq(schema.run.spanId, spanId)).get();
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
      .select({ sessionId: schema.run.sessionId })
      .from(schema.run)
      .where(eq(schema.run.spanId, spanId))
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
    return this.#d
      .select({
        seq: schema.attempt.seq,
        startedAt: schema.attempt.startedAt,
        endedAt: schema.attempt.endedAt,
      })
      .from(schema.attempt)
      .where(eq(schema.attempt.spanId, spanId))
      .orderBy(desc(schema.attempt.seq))
      .limit(1)
      .get() ?? null;
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
        spanId: schema.run.spanId,
        status: schema.run.status,
        kind: schema.run.kind,
        agentId: schema.run.agentId,
        startedAt: schema.run.startedAt,
        endedAt: schema.run.endedAt,
      })
      .from(schema.run)
      .where(eq(schema.run.sessionId, sessionId))
      .orderBy(desc(schema.run.startedAt))
      .all();
  }

  /** Expose the raw bun:sqlite connection for dynamic SQL (buildRunQuery, listSessions aggregate). */
  getRawDb(): Database {
    return this.#db;
  }

  listSpanOrigins(): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .orderBy(desc(schema.runOrigin.createdAt))
      .all()
      .map((r) => runOriginSelectSchema.parse(r));
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
