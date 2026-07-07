import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useWorkToday() {
  return useQuery({
    queryKey: ["work-today"],
    queryFn: () => api.getWorkToday(),
  });
}
