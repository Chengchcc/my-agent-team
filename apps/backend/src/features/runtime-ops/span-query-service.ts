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
