import { queryOptions } from "@tanstack/react-query";
import { type ArtifactListFilter, api } from "@/lib/api";
import { artifactKeys } from "./query-keys";

export function artifactsQuery(filter?: ArtifactListFilter) {
  const hasFilter =
    filter !== undefined &&
    Object.values(filter).some((v) => typeof v === "string" && v.length > 0);
  return queryOptions({
    queryKey: hasFilter ? ([...artifactKeys.all, "filtered", filter] as const) : artifactKeys.all,
    queryFn: () => api.listArtifacts(hasFilter ? filter : undefined),
  });
}

export function artifactMetaQuery(url: string) {
  return queryOptions({
    queryKey: [...artifactKeys.all, "meta", url] as const,
    queryFn: () => api.getArtifactMeta(url),
    staleTime: 60_000,
  });
}

/** One artifact's bytes, as the gallery's previews and the detail view read
 *  them. Keyed by the stored time too: an upload that replaces a file must not
 *  keep showing the previous content. */
export function artifactContentQuery(url: string, updatedAt: number) {
  return queryOptions({
    queryKey: [...artifactKeys.all, "content", url, updatedAt] as const,
    queryFn: () => api.downloadArtifact(url),
    // The key carries the stored time, so a replaced file is a new query; an
    // unchanged one is not downloaded again on every window focus.
    staleTime: 5 * 60_000,
  });
}
