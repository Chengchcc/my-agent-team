import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/events-schema.js";
import type {
  IssueEventKind,
  IssueEvent as IssueEventType,
  RunOpsEventKind,
  RunOpsEvent as RunOpsEventType,
  SpanOriginRow,
  SurfaceHealthRow,
} from "./types.js";

function toRunOpsEvent(r: typeof schema.runOpsEvent.$inferSelect): RunOpsEventType {
  return {
    seq: r.seq,
    spanId: r.spanId,
    attemptSeq: r.attemptSeq,
    kind: r.kind as RunOpsEventType["kind"],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    traceId: r.traceId,
    ts: r.ts,
  };
}

function toSpanOriginRow(r: typeof schema.runOrigin.$inferSelect): SpanOriginRow {
  return {
    spanId: r.spanId,
    conversationId: r.conversationId,
    sourceLedgerSeq: r.sourceLedgerSeq,
    agentMemberId: r.agentMemberId,
    surface: r.surface,
    traceId: r.traceId,
    traceparent: r.traceparent,
    idempotencyKey: r.idempotencyKey,
    issueId: r.issueId,
    cronJobId: r.cronJobId,
    fromStatus: r.fromStatus,
    originKind: r.originKind as SpanOriginRow["originKind"],
    createdAt: r.createdAt,
  };
}

function toSurfaceHealthRow(r: typeof schema.surfaceHealth.$inferSelect): SurfaceHealthRow {
  return {
    agentId: r.agentId,
    surface: r.surface,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    payload: r.payload,
    lastError: r.lastError,
    updatedAt: r.updatedAt,
  };
}

export class RuntimeOpsStore {
  #d: ReturnType<typeof drizzle<typeof schema>>;

  constructor(db: Database) {
    this.#d = drizzle(db, { schema, casing: "snake_case" });
  }

  // ─── run_ops_event ───

  appendRunEvent(input: {
    spanId: string;
    attemptSeq?: number;
    kind: RunOpsEventKind;
    traceId?: string;
    payload?: Record<string, unknown>;
  }): number {
    const row = this.#d
      .insert(schema.runOpsEvent)
      .values({
        spanId: input.spanId,
        attemptSeq: input.attemptSeq ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        traceId: input.traceId ?? null,
        ts: Date.now(),
      })
      .returning({ seq: schema.runOpsEvent.seq })
      .get();
    return row!.seq;
  }

  getRunEvents(spanId: string): RunOpsEventType[] {
    return this.#d
      .select()
      .from(schema.runOpsEvent)
      .where(eq(schema.runOpsEvent.spanId, spanId))
      .orderBy(schema.runOpsEvent.seq)
      .all()
      .map(toRunOpsEvent);
  }

  getRunEventsByTrace(traceId: string): RunOpsEventType[] {
    return this.#d
      .select()
      .from(schema.runOpsEvent)
      .where(eq(schema.runOpsEvent.traceId, traceId))
      .orderBy(schema.runOpsEvent.seq)
      .all()
      .map(toRunOpsEvent);
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

  getIssueEvents(issueId: string, afterSeq = 0): IssueEventType[] {
    return this.#d
      .select()
      .from(schema.issueEvent)
      .where(and(eq(schema.issueEvent.issueId, issueId), gt(schema.issueEvent.seq, afterSeq)))
      .orderBy(schema.issueEvent.seq)
      .all()
      .map(
        (r): IssueEventType => ({
          seq: r.seq,
          issueId: r.issueId,
          kind: r.kind as IssueEventKind,
          payload: JSON.parse(r.payload) as Record<string, unknown>,
          ts: r.ts,
        }),
      );
  }

  // ─── run_origin ───

  insertSpanOrigin(row: SpanOriginRow): void {
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
    return row ? toSpanOriginRow(row) : null;
  }

  getSpanOriginsByIssueId(issueId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.issueId, issueId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map(toSpanOriginRow);
  }

  getSpanOriginsByCronJobId(cronJobId: string): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.cronJobId, cronJobId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map(toSpanOriginRow);
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

  listSpanOrigins(): SpanOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .orderBy(desc(schema.runOrigin.createdAt))
      .all()
      .map(toSpanOriginRow);
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
    return row ? toSurfaceHealthRow(row) : undefined;
  }

  getSurfaceHealthsForAgent(agentId: string): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(eq(schema.surfaceHealth.agentId, agentId))
      .all()
      .map(toSurfaceHealthRow);
  }

  listSurfaceHealths(): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .orderBy(schema.surfaceHealth.agentId, schema.surfaceHealth.surface)
      .all()
      .map(toSurfaceHealthRow);
  }
}
