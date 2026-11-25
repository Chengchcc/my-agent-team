import { useQuery } from "@tanstack/react-query";
import {
  agentDetailQuery,
  agentIdentityQuery,
  agentListQuery,
  agentMemoryQuery,
  agentWorkspaceEntriesQuery,
} from "./queries";

export function useAgentList(opts?: { enabled?: boolean }) {
  return useQuery({ ...agentListQuery(), ...opts });
}

export function useAgentDetail(id: string) {
  return useQuery(agentDetailQuery(id));
}

export function useAgentIdentity(id: string) {
  return useQuery(agentIdentityQuery(id));
}

export function useAgentMemory(id: string) {
  return useQuery(agentMemoryQuery(id));
}

export function useAgentWorkspaceEntries(id: string, path: string) {
  return useQuery({ ...agentWorkspaceEntriesQuery(id, path), enabled: !!id });
}

export { useArchiveAgent, useCreateAgent, useSetIdentity, useUpdateAgent } from "./mutations";
export { agentKeys } from "./query-keys";
