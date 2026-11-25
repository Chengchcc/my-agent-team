import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { artifactContentQuery, artifactsQuery } from "./queries";
import { artifactKeys } from "./query-keys";

export function useArtifacts() {
  return useQuery(artifactsQuery());
}

/** One artifact's bytes, as a preview or the detail view reads them. A gallery
 *  card passes `enabled` and waits until it is on screen. */
export function useArtifactContent(
  url: string,
  updatedAt: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...artifactContentQuery(url, updatedAt),
    enabled: options?.enabled ?? true,
  });
}

export function useUploadArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.uploadArtifact,
    onSuccess: () => qc.invalidateQueries({ queryKey: artifactKeys.all }),
  });
}

export function useDeleteArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteArtifact,
    onSuccess: () => qc.invalidateQueries({ queryKey: artifactKeys.all }),
  });
}

export { artifactKeys } from "./query-keys";
