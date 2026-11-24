import { queryOptions } from "@tanstack/react-query";
import type { ApiReturn } from "@/lib/api";
import { api } from "@/lib/api";

export type PendingHitlAction = ApiReturn<typeof api.listPendingActions>["actions"][number];

/** Agent-run HITL (approval / ask) across every conversation - the global
 * read model behind the TopBar bell and the Today "Needs you" section.
 * 30s poll, same shape as the workflow waitingGates query. */
export function pendingActionsQuery() {
  return queryOptions({
    queryKey: ["pending-actions"],
    queryFn: () => api.listPendingActions(),
    refetchInterval: 30_000,
    select: (data) => data.actions ?? [],
  });
}

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
