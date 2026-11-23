import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** ADR 0040/0076: an MCP tool proposes, a page adopts. The inbox is what makes
 *  a proposal the assistant filed from chat adoptable without a page having
 *  been open at the time. */
export const proposalKeys = {
  pending: ["proposals", "pending"] as const,
};

export function usePendingProposals() {
  return useQuery({
    queryKey: proposalKeys.pending,
    queryFn: () => api.listPendingProposals(),
  });
}

/** Adopting a project_creation proposal applies BOTH halves: register the
 *  project and attach it to the members the proposer named. One decision, one
 *  click — a project nobody holds is a project nobody can work in. */
export function useAdoptProjectProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      proposalId: string;
      name: string;
      repoUrl: string;
      defaultBranch?: string;
      attachTo?: readonly string[];
    }) => {
      const created = await api.createProject({
        name: input.name,
        repoUrl: input.repoUrl,
        ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
      });
      const projectId = created.project.projectId;
      for (const agentId of input.attachTo ?? []) {
        const agent = await api.getAgent(agentId);
        const current = Array.isArray(agent.projects) ? agent.projects : [];
        if (current.includes(projectId)) continue;
        await api.updateAgent(agentId, { projects: [...current, projectId] });
      }
      await api.resolveProposal(input.proposalId, "adopted");
      return projectId;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: proposalKeys.pending });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useDiscardProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.resolveProposal(proposalId, "discarded"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: proposalKeys.pending }),
  });
}
