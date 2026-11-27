import { queryOptions } from "@tanstack/react-query";
import { api, type PendingProposalRow, type ProjectRow } from "@/lib/api";
import { projectKeys } from "./query-keys";

export function projectListQuery() {
  return queryOptions({
    queryKey: projectKeys.all,
    queryFn: () => api.listProjects(),
  });
}

export function projectDetailQuery(projectId: string) {
  return queryOptions({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
}

export function projectWorktreesQuery(projectId: string) {
  return queryOptions({
    queryKey: projectKeys.worktrees(projectId),
    queryFn: () => api.listProjectWorktrees(projectId),
  });
}

export function projectWorktreeDiffQuery(projectId: string, workspaceId: string) {
  return queryOptions({
    queryKey: projectKeys.worktreeDiff(projectId, workspaceId),
    queryFn: () => api.projectWorktreeDiff(projectId, workspaceId),
  });
}

/** The newest pending proposal for a project form since it opened. An existing project is
 *  addressed by id; a project that does not exist yet can only be recognised by having arrived
 *  just now. */
async function pendingProjectSuggestion(
  project: ProjectRow | null,
  openedAt: number,
): Promise<PendingProposalRow | null> {
  if (project !== null) {
    const found = await api
      .getPendingProposal("project_update", project.projectId)
      .catch(() => null);
    if (found === null) return null;
    return found.proposal ?? null;
  }
  const inbox = await api.listPendingProposals("project_creation").catch(() => null);
  if (inbox === null) return null;
  const sinceOpened = inbox.proposals.filter((row) => row.createdAt >= openedAt);
  const newest = sinceOpened[0];
  if (newest === undefined) return null;
  return newest;
}

export function projectSuggestionQuery(project: ProjectRow | null, openedAt: number) {
  const id = project === null ? "new" : project.projectId;
  return queryOptions({
    queryKey: projectKeys.suggestion(id),
    queryFn: () => pendingProjectSuggestion(project, openedAt),
    refetchInterval: 2000,
  });
}
