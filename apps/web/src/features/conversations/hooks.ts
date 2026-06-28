import { useQuery, useMutation, useQueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { conversationKeys } from "./query-keys";

function listByAgentQuery(agentId: string) {
  return queryOptions({ queryKey: conversationKeys.byAgent(agentId), queryFn: () => api.listConversations(agentId), enabled: !!agentId, staleTime: 10_000 });
}
export function useConversationList(agentId: string) { return useQuery(listByAgentQuery(agentId)); }

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteConversation(id) });
}

export { conversationKeys };
