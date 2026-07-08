import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const settingsKeys = {
  all: ["settings"] as const,
  system: ["settings", "system"] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => api.getSettings(),
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: settingsKeys.system,
    queryFn: () => api.getSystemInfo(),
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => api.updateSetting(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}
