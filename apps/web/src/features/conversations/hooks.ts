import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ConversationSnapshot } from "@/lib/api";
import { conversationKeys } from "./query-keys";

function listByAgentQuery(agentId: string) {
  return queryOptions({
    queryKey: conversationKeys.byAgent(agentId),
    queryFn: () => api.listConversations(agentId),
    enabled: !!agentId,
    staleTime: 10_000,
  });
}
export function useConversationList(agentId: string) {
  return useQuery(listByAgentQuery(agentId));
}

export function useRecentConversations() {
  return useQuery({
    queryKey: conversationKeys.recent(),
    queryFn: () => api.listConversations(),
    refetchInterval: 10_000,
  });
}

export function useDeleteConversation() {
  return useMutation({ mutationFn: (id: string) => api.deleteConversation(id) });
}

export function useCreateConversation() {
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createConversation>[0]) =>
      api.createConversation(body),
  });
}

export function useAddConversationMember(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.addConversationMember>[1]) =>
      api.addConversationMember(conversationId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
    },
  });
}

export function useRemoveConversationMember(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => api.removeConversationMember(conversationId, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
    },
  });
}

export function useConversationSnapshot(
  conversationId: string,
  initialData?: ConversationSnapshot | null,
) {
  return useQuery({
    queryKey: conversationKeys.detail(conversationId),
    queryFn: () => api.getConversation(conversationId),
    initialData: initialData ?? undefined,
  });
}

export function usePostConversationMessage(conversationId: string) {
  return useMutation({
    mutationFn: (params: { senderMemberId: string; text: string; addressedTo: string[] }) =>
      api.postConversationMessage(conversationId, {
        senderMemberId: params.senderMemberId,
        addressedTo: params.addressedTo,
        content: params.text,
      }),
  });
}

export function useResumeRun() {
  return useMutation({
    mutationFn: (params: { runId: string; approved: boolean; message?: string }) =>
      api.resumeRun(params.runId, params.approved, params.message),
  });
}

export { conversationKeys };
