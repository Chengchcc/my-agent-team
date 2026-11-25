import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { findMaintenanceWorkflow } from "./catalog";

export const wikiKeys = {
  pages: ["wiki", "pages"] as const,
  page: (path: string) => ["wiki", "page", path] as const,
  query: (text: string) => ["wiki", "query", text] as const,
  graph: ["wiki", "graph"] as const,
  lint: ["wiki", "lint"] as const,
  backlinks: (path: string) => ["wiki", "backlinks", path] as const,
  maintenance: () => ["wiki", "maintenance"] as const,
  maintenanceRuns: (workflowId: string) => ["wiki", "maintenance", "runs", workflowId] as const,
};

/** One page: frontmatter, body and revision. The same read serves the reading view and the
 *  index's summaries, so a page is fetched once. */
export function wikiPageQuery(path: string) {
  return queryOptions({
    queryKey: wikiKeys.page(path),
    queryFn: () => api.getWikiPage(path),
    staleTime: 60_000,
  });
}

/** Full-text search over titles and bodies. An empty term is not a search: the query stays off. */
export function wikiSearchQuery(text: string) {
  const term = text.trim();
  return queryOptions({
    queryKey: wikiKeys.query(term),
    queryFn: () => api.queryWiki(term),
    enabled: term !== "",
    staleTime: 60_000,
  });
}

/** The one workflow that maintains the wiki, or nothing. Read-only: this page never runs it. */
export function wikiMaintenanceQuery() {
  return queryOptions({
    queryKey: wikiKeys.maintenance(),
    queryFn: () => api.listWorkflowDefinitions(),
    select: (data) => findMaintenanceWorkflow(data.definitions),
    staleTime: 60_000,
  });
}

export function wikiMaintenanceRunsQuery(workflowId: string) {
  return queryOptions({
    queryKey: wikiKeys.maintenanceRuns(workflowId),
    queryFn: () => api.listWorkflowExecutions(workflowId),
    enabled: workflowId !== "",
    staleTime: 30_000,
  });
}
