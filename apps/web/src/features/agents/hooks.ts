import { useQuery } from "@tanstack/react-query";
import { agentDetailQuery, agentIdentityQuery, agentListQuery } from "./queries";

export function useAgentList(filters?: Record<string, unknown>) {
  return useQuery(agentListQuery(filters));
}

export function useAgentDetail(id: string) {
  return useQuery(agentDetailQuery(id));
}

export function useAgentIdentity(id: string) {
  return useQuery(agentIdentityQuery(id));
}

export { useArchiveAgent, useCreateAgent, useSetIdentity, useUpdateAgent } from "./mutations";
export { agentKeys } from "./query-keys";
