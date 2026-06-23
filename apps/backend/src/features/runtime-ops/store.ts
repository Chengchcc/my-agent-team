import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/events-schema.js";
import type {
  IssueEventKind,
  IssueEvent as IssueEventType,
  RunnerHealthRow,
  RunOpsEventKind,
  RunOpsEvent as RunOpsEventType,
  RunOriginRow,
  SurfaceHealthRow,
} from "./types.js";

function toRunOpsEvent(r: typeof schema.runOpsEvent.$inferSelect): RunOpsEventType {
  return {
    seq: r.seq,
    runId: r.runId,
    attemptId: r.attemptId,
    kind: r.kind as RunOpsEventType["kind"],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    traceId: r.traceId,
    ts: r.ts,
  };
}

function toRunOriginRow(r: typeof schema.runOrigin.$inferSelect): RunOriginRow {
  return {
    runId: r.runId,
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
    originKind: r.originKind as RunOriginRow["originKind"],
    createdAt: r.createdAt,
  };
}

function toRunnerHealthRow(r: typeof schema.runnerHealth.$inferSelect): RunnerHealthRow {
  return {
    agentId: r.agentId,
    lastSeenAt: r.lastSeenAt,
    uptimeMs: r.uptimeMs ?? 0,
    activeRunCount: r.activeRunCount,
    activeRunIds: r.activeRunIds,
    checkpointerOk: r.checkpointerOk,
    workspaceOk: r.workspaceOk,
    lastError: r.lastError,
    updatedAt: r.updatedAt,
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
    runId: string;
    attemptId?: string;
    kind: RunOpsEventKind;
    traceId?: string;
    payload?: Record<string, unknown>;
  }): number {
    const row = this.#d
      .insert(schema.runOpsEvent)
      .values({
        runId: input.runId,
        attemptId: input.attemptId ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        traceId: input.traceId ?? null,
        ts: Date.now(),
      })
      .returning({ seq: schema.runOpsEvent.seq })
      .get();
    return row!.seq;
  }

  getRunEvents(runId: string): RunOpsEventType[] {
    return this.#d
      .select()
      .from(schema.runOpsEvent)
      .where(eq(schema.runOpsEvent.runId, runId))
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

  insertRunOrigin(row: RunOriginRow): void {
    // Invariant: issue-driven runs must carry a non-empty fromStatus
    if (row.issueId != null && row.fromStatus === "") {
      throw new Error(
        `run_origin with issueId must carry a non-empty fromStatus (runId=${row.runId})`,
      );
    }
    this.#d
      .insert(schema.runOrigin)
      .values({
        runId: row.runId,
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

  getRunOrigin(runId: string): RunOriginRow | null {
    const row = this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.runId, runId))
      .get();
    return row ? toRunOriginRow(row) : null;
  }

  getRunOriginsByIssueId(issueId: string): RunOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.issueId, issueId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map(toRunOriginRow);
  }

  getRunOriginsByCronJobId(cronJobId: string): RunOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .where(eq(schema.runOrigin.cronJobId, cronJobId))
      .orderBy(schema.runOrigin.createdAt)
      .all()
      .map(toRunOriginRow);
  }

  getRuns(runIds: string[]): Array<{
    runId: string;
    threadId: string;
    agentId: string;
    status: string;
    kind: string;
    parentRunId: string | null;
    startedAt: number;
    endedAt: number | null;
  }> {
    if (runIds.length === 0) return [];
    return this.#d
      .select()
      .from(schema.run)
      .where(inArray(schema.run.runId, runIds))
      .all()
      .map((r) => ({
        runId: r.runId,
        threadId: r.threadId,
        agentId: r.agentId,
        status: r.status,
        kind: r.kind,
        parentRunId: r.parentRunId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      }));
  }

  listRunOrigins(): RunOriginRow[] {
    return this.#d
      .select()
      .from(schema.runOrigin)
      .orderBy(desc(schema.runOrigin.createdAt))
      .all()
      .map(toRunOriginRow);
  }

  // ─── runner_health ───

  upsertRunnerHealth(input: {
    agentId: string;
    uptimeMs: number;
    activeRunIds: string[];
    checkpointerOk: boolean;
    workspaceOk: boolean;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#d
      .insert(schema.runnerHealth)
      .values({
        agentId: input.agentId,
        lastSeenAt: now,
        uptimeMs: input.uptimeMs,
        activeRunCount: input.activeRunIds.length,
        activeRunIds: JSON.stringify(input.activeRunIds),
        checkpointerOk: input.checkpointerOk ? 1 : 0,
        workspaceOk: input.workspaceOk ? 1 : 0,
        lastError: input.lastError ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.runnerHealth.agentId,
        set: {
          lastSeenAt: now,
          uptimeMs: input.uptimeMs,
          activeRunCount: input.activeRunIds.length,
          activeRunIds: JSON.stringify(input.activeRunIds),
          checkpointerOk: input.checkpointerOk ? 1 : 0,
          workspaceOk: input.workspaceOk ? 1 : 0,
          lastError: input.lastError ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  getRunnerHealth(agentId: string): RunnerHealthRow | undefined {
    const row = this.#d
      .select()
      .from(schema.runnerHealth)
      .where(eq(schema.runnerHealth.agentId, agentId))
      .get();
    return row ? toRunnerHealthRow(row) : undefined;
  }

  listRunnerHealths(): RunnerHealthRow[] {
    return this.#d
      .select()
      .from(schema.runnerHealth)
      .orderBy(schema.runnerHealth.agentId)
      .all()
      .map(toRunnerHealthRow);
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
