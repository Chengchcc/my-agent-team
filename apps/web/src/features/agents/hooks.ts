import { useQuery } from "@tanstack/react-query";
import { agentDetailQuery, agentIdentityQuery, agentListQuery } from "./queries";

import type { UseQueryOptions } from "@tanstack/react-query";

export function useAgentList(opts?: { enabled?: boolean }) {
  return useQuery({ ...agentListQuery(), ...opts });
}

export function useAgentDetail(id: string) {
  return useQuery(agentDetailQuery(id));
}

export function useAgentIdentity(id: string) {
  return useQuery(agentIdentityQuery(id));
}

export { useArchiveAgent, useCreateAgent, useSetIdentity, useUpdateAgent } from "./mutations";
export { agentKeys } from "./query-keys";
