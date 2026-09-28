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
