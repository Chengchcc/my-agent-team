import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { modelKeys } from "@/features/models/hooks";
import { api } from "@/lib/api";
import { customProviderKeysQuery, providersQuery } from "./queries";
import { providerKeys } from "./query-keys";

export function useProviders() {
  return useQuery(providersQuery());
}

export function useSetProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { apiKey?: string; baseUrl?: string } }) =>
      api.setProvider(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.all });
      qc.invalidateQueries({ queryKey: modelKeys.all });
      toast.success("Provider saved");
    },
    onError: (e) => toast.error(`Failed to save provider: ${String(e)}`),
  });
}

export function useClearProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.clearProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.all });
      qc.invalidateQueries({ queryKey: modelKeys.all });
      toast.success("Provider cleared");
    },
    onError: (e) => toast.error(`Failed to clear provider: ${String(e)}`),
  });
}

export function useCustomProviderKeys() {
  return useQuery(customProviderKeysQuery());
}

export function useSetCustomProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, apiKey }: { name: string; apiKey: string }) =>
      api.setCustomProviderKey(name, apiKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.customKeys });
      qc.invalidateQueries({ queryKey: modelKeys.all });
      toast.success("Provider key saved");
    },
    onError: (e) => toast.error(`Failed to save key: ${String(e)}`),
  });
}

export function useClearCustomProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.clearCustomProviderKey(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.customKeys });
      qc.invalidateQueries({ queryKey: modelKeys.all });
      toast.success("Provider key cleared");
    },
    onError: (e) => toast.error(`Failed to clear key: ${String(e)}`),
  });
}
