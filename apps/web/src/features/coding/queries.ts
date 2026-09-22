import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const codingKeys = {
  all: ["coding"] as const,
  terminals: ["coding", "terminals"] as const,
};

export const codingTerminalsQuery = () =>
  queryOptions({
    queryKey: codingKeys.terminals,
    queryFn: () => api.listCodingTerminals(),
    // Terminal status (running/exited) is display state, not critical data —
    // a short poll keeps the rail dots honest; live output rides the WS.
    refetchInterval: 4000,
  });
