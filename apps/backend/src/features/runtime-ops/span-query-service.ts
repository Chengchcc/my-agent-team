import type { Database } from "bun:sqlite";
import type { SpanSupervisor } from "../span/supervisor.js";
import type { RuntimeOpsStore } from "./store.js";

// ─── RunSqlFilter (replaces sql+= if-chain) ──────────────

export interface RunSqlFilter {
  agentId?: string;
  sessionId?: string;
  conversationId?: string;
  status?: string;
}

function escapeLike(s: string): string {
  return s.replace(/[%_]/g, "\\$&");
}

export function buildRunQuery(
  f: RunSqlFilter,
  limit: number,
): { sql: string; args: (string | number)[] } {
  const clauses: string[] = ["1=1"];
  const args: (string | number)[] = [];
  const add = (cond: string, v: string | number) => {
    clauses.push(cond);
    args.push(v);
  };
  if (f.agentId) add("r.agent_id = ?", f.agentId);
  if (f.sessionId) add("r.session_id = ?", f.sessionId);
  if (f.conversationId) add("r.session_id LIKE ? ESCAPE '\\'", `${escapeLike(f.conversationId)}:%`);
  if (f.status) add("r.status = ?", f.status);
  return {
    sql: `SELECT r.span_id, r.session_id, r.agent_id, r.kind, r.parent_span_id, r.status, r.started_at, r.ended_at FROM run r WHERE ${clauses.join(" AND ")} ORDER BY r.started_at DESC LIMIT ?`,
    args: [...args, limit],
  };
}

// ─── Post-query predicates (replaces items.filter if-chain) ──

export interface PostFilter {
  transport?: string;
  heartbeat?: "stale" | "live";
  traceId?: string;
}

type RunItem = {
  runnerTransport?: string;
  heartbeatAt?: number | null;
  traceId?: string;
};

export function applyPostFilters(items: RunItem[], f: PostFilter): RunItem[] {
  let result = items;
  if (f.transport) result = result.filter((i) => i.runnerTransport === f.transport);
  if (f.heartbeat === "stale")
    result = result.filter((i) => i.heartbeatAt != null && Date.now() - i.heartbeatAt > 30_000);
  if (f.heartbeat === "live")
    result = result.filter((i) => i.heartbeatAt == null || Date.now() - i.heartbeatAt <= 30_000);
  if (f.traceId) result = result.filter((i) => i.traceId === f.traceId);
  return result;
}

// ─── RunQueryService ──────────────────────────────────────

export function createRunQueryService(deps: {
  db: Database;
  opsStore: RuntimeOpsStore;
  supervisor: SpanSupervisor;
}) {
  return {
    listRuns(params: {
      agentId?: string;
      sessionId?: string;
      conversationId?: string;
      status?: string;
      transport?: string;
      heartbeat?: "stale" | "live";
      traceId?: string;
      limit?: number;
    }) {
      const raw = params.limit ?? 50;
      const limit = Number.isFinite(raw) && raw > 0 && raw <= 500 ? Math.floor(raw) : 50;

      const { sql, args } = buildRunQuery(
        {
          agentId: params.agentId,
          sessionId: params.sessionId,
          conversationId: params.conversationId,
          status: params.status,
        },
        limit,
      );

      const rows = deps.db.query(sql).all(...args) as Array<{
        span_id: string;
        session_id: string;
        agent_id: string;
        kind: string;
        parent_span_id: string | null;
        status: string;
        started_at: number;
        ended_at: number | null;
      }>;

      const items = rows.map((r) => {
        const session = deps.supervisor.getActive().get(r.span_id);
        return {
          spanId: r.span_id,
          sessionId: r.session_id,
          agentId: r.agent_id,
          kind: r.kind,
          parentSpanId: r.parent_span_id,
          status: r.status,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          runnerTransport: (session?.transportKind ?? "detached") as
            | "attached"
            | "noop"
            | "detached",
          heartbeatAt: null as number | null,
          traceId: undefined as string | undefined,
        };
      });

      return applyPostFilters(items, {
        transport: params.transport,
        heartbeat: params.heartbeat,
        traceId: params.traceId,
      });
    },

    cancel(spanId: string): { ok: boolean; error?: string; state?: string } {
      const session = deps.supervisor.getActive().get(spanId);
      if (!session) return { ok: false, error: "not_found" };
      const cancelled = deps.supervisor.cancel(spanId);
      if (!cancelled) return { ok: false, error: "not_found" };
      return { ok: true, state: "abort_sent" };
    },
  };
}
