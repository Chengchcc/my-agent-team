import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** ADR 0074 S3: the wiki read model. queryFn lives here, not in pages — the
 *  contract audit treats an inline queryFn as a rotted seam. */

export const wikiKeys = {
  pages: ["wiki", "pages"] as const,
  page: (path: string) => ["wiki", "page", path] as const,
  query: (text: string) => ["wiki", "query", text] as const,
  lint: ["wiki", "lint"] as const,
};

export function useWikiPages() {
  return useQuery({ queryKey: wikiKeys.pages, queryFn: () => api.listWikiPages() });
}

export function useWikiPage(path: string | null) {
  return useQuery({
    queryKey: wikiKeys.page(path ?? ""),
    queryFn: () => api.getWikiPage(path ?? ""),
    enabled: path !== null && path !== "",
  });
}

export function useWikiSearch(text: string) {
  return useQuery({
    queryKey: wikiKeys.query(text),
    queryFn: () => api.queryWiki(text),
    enabled: text.trim() !== "",
  });
}

export function useWikiBacklinks(path: string | null) {
  return useQuery({
    queryKey: ["wiki", "backlinks", path ?? ""],
    queryFn: () => api.wikiBacklinks(path ?? ""),
    enabled: path !== null && path !== "",
  });
}

export function useWikiLint() {
  return useQuery({ queryKey: wikiKeys.lint, queryFn: () => api.wikiLint() });
}
