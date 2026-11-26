import { useQueries, useQuery } from "@tanstack/react-query";
import { type ApiReturn, api } from "@/lib/api";
import {
  wikiKeys,
  wikiMaintenanceQuery,
  wikiMaintenanceRunsQuery,
  wikiPageQuery,
  wikiSearchQuery,
} from "./queries";
import { leadText } from "./reader";

export { wikiKeys };

/** ADR 0074 S3: the wiki read model. queryFn lives here, not in pages — the
 *  contract audit treats an inline queryFn as a rotted seam. */

/** A page as the backend returns it; the read can also answer an error body. */
export type WikiPageData = Exclude<ApiReturn<typeof api.getWikiPage>, { error: string }>;

export function isWikiPage(data: unknown): data is WikiPageData {
  if (typeof data !== "object" || data === null) return false;
  return "frontmatter" in data;
}

export function useWikiPages() {
  return useQuery({ queryKey: wikiKeys.pages, queryFn: () => api.listWikiPages() });
}

export function useWikiPage(path: string | null) {
  return useQuery({
    ...wikiPageQuery(path ?? ""),
    enabled: path !== null && path !== "",
  });
}

export function useWikiGraph() {
  return useQuery({ queryKey: wikiKeys.graph, queryFn: () => api.graphWiki() });
}

export function useWikiBacklinks(path: string | null) {
  return useQuery({
    queryKey: wikiKeys.backlinks(path ?? ""),
    queryFn: () => api.wikiBacklinks(path ?? ""),
    enabled: path !== null && path !== "",
  });
}

export function useWikiLint() {
  return useQuery({ queryKey: wikiKeys.lint, queryFn: () => api.wikiLint() });
}

export function useWikiSearch(text: string) {
  const options = wikiSearchQuery(text);
  return useQuery(options);
}

export function useWikiMaintenance() {
  const options = wikiMaintenanceQuery();
  return useQuery(options);
}

export function useWikiMaintenanceRuns(workflowId: string) {
  const options = wikiMaintenanceRunsQuery(workflowId);
  return useQuery(options);
}

/** The opening line of each listed page, for the index. The page list carries no summary, so the
 *  bodies are read; they are the same cached reads the reading view uses.
 *  ponytail: one request per listed page; tens of pages is the ceiling this was written for. */
export function useWikiLeads(paths: readonly string[]) {
  const results = useQueries({
    queries: paths.map((path) => ({ ...wikiPageQuery(path), enabled: path !== "" })),
  });
  const leads = new Map<string, string>();
  results.forEach((result, index) => {
    const path = paths[index];
    const body = isWikiPage(result.data) ? result.data.body : null;
    if (path === undefined || body === null) return;
    leads.set(path, leadText(body));
  });
  return { leads, pending: results.some((result) => result.isPending) };
}
