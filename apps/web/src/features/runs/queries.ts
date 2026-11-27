import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** ADR 0061: the attention debt view (awaiting you / waiting on agent /
 *  unseen results). Same 30s poll as the bell: it is a read model, and a
 *  stale debt list is worse than a slightly late one. */
export function attentionQuery() {
  return queryOptions({
    queryKey: ["attention"],
    queryFn: ({ signal }) => api.attention(signal),
    refetchInterval: 30_000,
  });
}

/** The executions that wait for a person, as rows. The nav badge counts the same request: one
 *  cache entry, two selections. */
export function waitingGatesQuery() {
  return queryOptions({
    queryKey: ["workflow-executions-gates"],
    queryFn: () => api.listWorkflowExecutions(),
    refetchInterval: 30_000,
    select: (data) => (data.executions ?? []).filter((e) => e.status === "waiting_human"),
  });
}

/** What one gate waits on. Read when a person opens that gate's scope. */
export function gateTraceQuery(executionId: string) {
  return queryOptions({
    queryKey: ["workflow-executions", executionId, "trace"],
    queryFn: () => api.getWorkflowExecutionTrace(executionId),
  });
}
