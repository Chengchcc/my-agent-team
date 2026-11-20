import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** ADR 0074: the requirement read model. The repo's contract audit routes
 *  every queryFn through a features hooks file — inline ones in pages are
 *  how the BFF seam rots. */

export const requirementKeys = {
  all: ["requirements"] as const,
  detail: (id: string) => ["requirements", id] as const,
};

export function useRequirements() {
  return useQuery({
    queryKey: requirementKeys.all,
    queryFn: () => api.listRequirements(),
  });
}

export function useRequirement(id: string) {
  return useQuery({
    queryKey: requirementKeys.detail(id),
    queryFn: () => api.getRequirement(id),
  });
}
