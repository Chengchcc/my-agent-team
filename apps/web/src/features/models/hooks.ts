import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

export const modelKeys = {
  all: ["models"] as const,
};

export const harnessKeys = {
  all: ["harnesses"] as const,
};

function harnessListQuery() {
  return queryOptions({ queryKey: harnessKeys.all, queryFn: api.listHarnesses });
}

/** The harnesses and the models each declares. Costs a probe server-side, so it
 *  is cached by react-query and refetched only when a harness is (re)configured. */
export function useHarnessList() {
  return useQuery(harnessListQuery());
}

function modelListQuery() {
  return queryOptions({ queryKey: modelKeys.all, queryFn: api.listModels });
}

export function useModelList() {
  return useQuery(modelListQuery());
}

/** Probe every configured provider's live `/models` endpoint, persist the
 *  updated catalog server-side, and refresh both `/api/models` and `/api/harnesses`. */
export function useRefreshModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshModels(),
    onSuccess: (res) => {
      qc.setQueryData(modelKeys.all, { providers: res.providers });
      void qc.invalidateQueries({ queryKey: harnessKeys.all });
      if (res.updatedProviders.length > 0) {
        toast.success(
          t("Synced models from {count} provider(s)", { count: res.updatedProviders.length }),
        );
      } else if (res.failedProviders.length > 0) {
        toast.warning(
          t("Some providers failed: {providers}", { providers: res.failedProviders.join(", ") }),
        );
      } else {
        toast.info(t("No reachable provider updated"));
      }
    },
    onError: (e) => {
      toast.error(
        t("Failed to refresh models: {reason}", {
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });
}
