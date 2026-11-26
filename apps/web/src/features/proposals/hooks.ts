import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PendingProposalRow } from "@/lib/api";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { pendingProposalsQuery, proposalKeys } from "./queries";

export { proposalKeys } from "./queries";
/** A proposal waiting for a decision, as the inbox lists it. */
export type PendingProposal = PendingProposalRow;

export function usePendingProposals() {
  return useQuery(pendingProposalsQuery());
}

/** Adopting APPLIES (ADR 0040): the deployment runs the applier and only then resolves the row,
 *  so one click is one decision. Agent and workflow proposals are not adopted from here: the
 *  server refuses the second and the first is reviewed in the agent's editor. */
export function useAdoptProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.resolveProposal(proposalId, "adopted"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: proposalKeys.pending });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(t("Adopted and applied."));
    },
    onError: (err) => {
      toast.error(t("Could not adopt"), {
        description: err instanceof Error ? err.message : t("Unknown error"),
      });
    },
  });
}

export function useDiscardProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.resolveProposal(proposalId, "discarded"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: proposalKeys.pending });
      toast.success(t("Discarded."));
    },
    onError: (err) => {
      toast.error(t("Could not discard"), {
        description: err instanceof Error ? err.message : t("Unknown error"),
      });
    },
  });
}
