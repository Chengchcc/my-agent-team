import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agentRunDetailQuery } from "@/features/ops/queries";
import { projectListQuery } from "@/features/projects/queries";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { RequirementChange } from "./goal-fields";
import type { RunRecord } from "./graph";
import {
  isRequirementDetail,
  type RequirementDetail,
  type RequirementListRow,
  requirementDetailQuery,
  requirementKeys,
  requirementsQuery,
} from "./queries";

export { requirementKeys } from "./queries";

/** ADR 0074: the requirement read model. The repo's contract audit routes every queryFn
 *  through a features file, so the pages only call hooks. */
export function useRequirements() {
  return useQuery(requirementsQuery());
}

/** The project list, under the same query key as the projects page. The navigation rail reads
 *  it from here. */
export function useProjects() {
  return useQuery(projectListQuery());
}

export function useRequirement(id: string) {
  return useQuery(requirementDetailQuery(id));
}

/** The detail of several goals at once, by id. The list shows each goal's derived status and the
 *  agents that took part, and both live only in the detail. */
export function useRequirementDetails(ids: readonly string[]): Map<string, RequirementDetail> {
  return useQueries({
    queries: ids.map((id) => requirementDetailQuery(id)),
    combine: (results) => {
      const byId = new Map<string, RequirementDetail>();
      results.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined) return;
        const detail = result.data;
        if (isRequirementDetail(detail)) byId.set(id, detail);
      });
      return byId;
    },
  });
}

/** The run records behind a goal's runs: the worker's conversation and who dispatched each
 *  run. A run still loading, or gone, is simply absent from the map. */
export function useRunRecords(runIds: readonly string[]): Map<string, RunRecord> {
  return useQueries({
    queries: runIds.map((runId) => agentRunDetailQuery(runId)),
    combine: (results) => {
      const byId = new Map<string, RunRecord>();
      results.forEach((result, index) => {
        const runId = runIds[index];
        const run = result.data?.run;
        if (runId === undefined || run === undefined) return;
        byId.set(runId, {
          runId,
          agentId: run.agentId,
          conversationId: run.conversationId,
          authorization: run.authorization,
          parentRunId: run.parentRunId,
          status: run.status,
        });
      });
      return byId;
    },
  });
}

/** What a person may correct on a goal (the PATCH fields). The project link is not among them:
 *  the endpoint does not take it. */
export type RequirementPatch = RequirementChange & {
  status?: "open" | "done" | "cancelled";
};

export function useUpdateRequirement(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: RequirementPatch) => api.updateRequirement(id, { ...patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: requirementKeys.all });
      void qc.invalidateQueries({ queryKey: requirementKeys.detail(id) });
    },
    onError: (err) =>
      toast.error(t("Could not update the requirement"), {
        description: err instanceof Error ? err.message : String(err),
      }),
  });
}

export type { RequirementListRow };
