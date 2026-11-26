import { queryOptions } from "@tanstack/react-query";
import { api, type WorkflowDefinitionRow } from "@/lib/api";

export const workflowKeys = {
  all: ["workflows"] as const,
  list: () => ["workflow-definitions"] as const,
  detail: (id: string) => ["workflow-definitions", id] as const,
  executions: (id: string) => ["workflow-executions", id] as const,
  proposal: (id: string) => ["workflow-definitions", id, "proposal"] as const,
};

/** U4 (UX audit): surfaces human gates across every workflow execution.
 *  One list call per 30s; the nav badge reads waiting_human count. */
export function waitingGatesQuery() {
  return queryOptions({
    queryKey: ["workflow-executions-gates"],
    queryFn: () => api.listWorkflowExecutions(),
    refetchInterval: 30_000,
    select: (data) => (data.executions ?? []).filter((e) => e.status === "waiting_human").length,
  });
}

export function workflowListQuery() {
  return queryOptions({
    queryKey: workflowKeys.list(),
    queryFn: () => api.listWorkflowDefinitions(),
  });
}

export function workflowDefinitionQuery(workflowId: string) {
  return queryOptions({
    queryKey: workflowKeys.detail(workflowId),
    queryFn: () => api.getWorkflowDefinition(workflowId),
  });
}

/** The runs of one saved workflow. Polled only while one is in flight (the list component
 *  owns that poll). */
export function workflowExecutionsQuery(workflowId: string) {
  return queryOptions({
    queryKey: workflowKeys.executions(workflowId),
    queryFn: () => api.listWorkflowExecutions(workflowId),
  });
}

/** How often the editor looks for a suggestion the PA filed for its workflow. */
export const PROPOSAL_POLL_MS = 2000;

/** The pending `workflow_definition` proposal for a workflow, or null. A durable row (ADR
 *  0040): one that arrived while the editor was closed is still there when it opens. */
export function workflowProposalQuery(workflowId: string, polling: boolean) {
  return queryOptions({
    queryKey: workflowKeys.proposal(workflowId),
    queryFn: () => api.getPendingProposal("workflow_definition", workflowId),
    refetchInterval: polling ? PROPOSAL_POLL_MS : false,
  });
}

export type WorkflowListRow = WorkflowDefinitionRow;

/** The instances of a workflow as the rows list them. */
export type WorkflowExec = {
  executionId: string;
  triggeredBy?: string | null;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};
