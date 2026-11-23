import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

export const proposalKeys = {
  pending: ["proposals", "pending"] as const,
};

export interface PendingProposal {
  id: string;
  kind: string;
  targetId: string;
  payload: unknown;
  createdAt: number;
}

export function usePendingProposals() {
  return useQuery({
    queryKey: proposalKeys.pending,
    queryFn: () => api.listPendingProposals(),
  });
}

/** Adopting APPLIES (ADR 0040): the deployment runs the applier and only then
 *  resolves the row, so one click is one decision — no second page, no
 *  "adopted" that changed nothing (the previous inbox could do exactly that). */
export function useAdoptProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.resolveProposal(proposalId, "adopted"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: proposalKeys.pending });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Adopted and applied.");
    },
    onError: (err) => {
      toast.error("Could not adopt", {
        description: err instanceof Error ? err.message : "Unknown error",
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
      toast.success("Discarded.");
    },
  });
}
