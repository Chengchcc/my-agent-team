import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { artifactKeys } from "./query-keys";

export function artifactsQuery() {
  return queryOptions({
    queryKey: artifactKeys.all,
    queryFn: () => api.listArtifacts(),
  });
}

/** One artifact's bytes, as the gallery's previews and the detail view read
 *  them. Keyed by the stored time too: an upload that replaces a file must not
 *  keep showing the previous content. */
export function artifactContentQuery(url: string, updatedAt: number) {
  return queryOptions({
    queryKey: [...artifactKeys.all, "content", url, updatedAt] as const,
    queryFn: () => api.downloadArtifact(url),
  });
}
