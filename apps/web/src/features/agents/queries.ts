import { queryOptions } from "@tanstack/react-query";
import { type AgentMemory, api } from "@/lib/api";
import { agentKeys } from "./query-keys";

export type WorkspaceEntry = {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number | null;
};

export function agentListQuery(filters?: Record<string, unknown>) {
  return queryOptions({
    queryKey: agentKeys.list(filters),
    queryFn: api.listAgents,
  });
}

export function agentDetailQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.detail(id),
    queryFn: () => api.getAgent(id),
  });
}

export function agentIdentityQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.identity(id),
    queryFn: () => api.getIdentity(id),
  });
}

export function agentMemoryQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.memory(id),
    queryFn: () => api.getAgentMemory(id) as Promise<AgentMemory>,
  });
}

export function agentWorkspaceEntriesQuery(id: string, path: string) {
  return queryOptions({
    queryKey: agentKeys.workspace(id, path),
    queryFn: () =>
      api.listWorkspaceEntries(id, path) as Promise<{ path: string; entries: WorkspaceEntry[] }>,
  });
}

/** The newest pending `agent_config` proposal for a member form: addressed to the member's id,
 *  or to the reserved draft id while a new member is being created. Reading it decides nothing;
 *  polled like the other proposal readers, so a suggestion the PA files while the form is open
 *  shows up beside it. */
export function agentSuggestionQuery(targetId: string) {
  return queryOptions({
    queryKey: agentKeys.suggestion(targetId),
    queryFn: async () => {
      const found = await api.getPendingProposal("agent_config", targetId).catch(() => null);
      if (found === null) return null;
      return found.proposal;
    },
    refetchInterval: 2000,
  });
}
