import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { conversationKeys } from "./query-keys";

export function conversationListQuery(agentId: string) {
  return queryOptions({
    queryKey: conversationKeys.byAgent(agentId),
    queryFn: () => api.listConversations(agentId),
    enabled: !!agentId,
    staleTime: 10_000,
  });
}

export function recentConversationsQuery() {
  return queryOptions({
    queryKey: conversationKeys.recent(),
    // Polled every 10s: a cancelled poll must stop, not land in a gone tree.
    queryFn: ({ signal }) => api.listConversations(undefined, signal),
    refetchInterval: 10_000,
  });
}

export function conversationDetailQuery(id: string) {
  return queryOptions({
    queryKey: conversationKeys.detail(id),
    queryFn: ({ signal }) => api.getConversation(id, signal),
    refetchInterval: 3_000,
  });
}

export function conversationSearchQuery(q: string) {
  return queryOptions({
    queryKey: conversationKeys.search(q),
    queryFn: () => api.searchConversations(q),
  });
}

export function conversationInputsQuery(conversationId: string) {
  return queryOptions({
    queryKey: conversationKeys.inputs(conversationId),
    queryFn: () => api.listConversationInputs(conversationId),
  });
}
