import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const larkKeys = {
  surface: (agentId: string) => ["lark", "surface", agentId] as const,
};

/** The surface read model, polled only while it is still moving: authorizing
 *  and starting are the two states that change without user action, so a
 *  settled surface costs one request, not a heartbeat. */
export function larkSurfaceQuery(agentId: string) {
  return queryOptions({
    queryKey: larkKeys.surface(agentId),
    queryFn: () => api.larkSurface(agentId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "authorizing" || status === "starting") return 3000;
      return false;
    },
  });
}
