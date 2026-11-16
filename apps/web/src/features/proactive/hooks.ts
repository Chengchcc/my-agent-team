import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const proactiveKeys = {
  events: (params?: { agentId?: string; limit?: number }) =>
    ["proactive-events", params?.agentId ?? "all", params?.limit ?? 50] as const,
};

/** The ambient ledger (ADR 0046/0048): what the agent would have done, did
 *  do, or failed to assess. Read-only — rules live on the agent config. */
export function useProactiveEvents(params?: { agentId?: string; limit?: number }) {
  return useQuery({
    queryKey: proactiveKeys.events(params),
    queryFn: () => api.listProactiveEvents(params),
  });
}
