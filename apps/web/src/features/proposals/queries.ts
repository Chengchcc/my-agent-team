import { queryOptions } from "@tanstack/react-query";
import { api, type PendingProposalRow, type ProposalKindName } from "@/lib/api";

export const proposalKeys = {
  all: ["proposals"] as const,
  pending: ["proposals", "pending"] as const,
};

/** Every proposal still waiting for a decision. */
export function pendingProposalsQuery() {
  return queryOptions({
    queryKey: proposalKeys.pending,
    queryFn: () => api.listPendingProposals(),
  });
}

/** The kinds in the order the inbox lists them. */
export const PROPOSAL_KINDS: readonly ProposalKindName[] = [
  "agent_config",
  "workflow_definition",
  "project_creation",
  "project_update",
];

export const PROPOSAL_KIND_LABELS: Record<ProposalKindName, string> = {
  agent_config: "Agent config",
  workflow_definition: "Workflow definition",
  project_creation: "New project",
  project_update: "Project change",
};

/** The editor that owns a proposal's target. An `agent_config` proposal is reviewed in the
 *  agent's editor. A `workflow_definition` proposal can be verified and adopted directly in the
 *  inbox (ADR 0084) OR opened in the workflow editor as an unsaved draft. */
export function owningEditorHref(
  proposal: Pick<PendingProposalRow, "kind" | "targetId">,
): string | null {
  if (proposal.kind === "agent_config") return `/team/${proposal.targetId}/edit`;
  if (proposal.kind === "workflow_definition") return `/workflows/${proposal.targetId}?edit=1`;
  return null;
}

/** Whether adopting the proposal here applies it at once. */
export function appliesFromInbox(proposal: Pick<PendingProposalRow, "kind" | "targetId">): boolean {
  if (proposal.kind === "workflow_definition") return true;
  const href = owningEditorHref(proposal);
  return href === null;
}

/** The page where the proposal's kind of resource lives, for looking at what it would change. */
export function resourcePageHref(kind: ProposalKindName): string | null {
  if (kind === "project_creation") return "/team/projects";
  if (kind === "project_update") return "/team/projects";
  return null;
}
