import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { authPasswordQuery } from "./queries";
import { authKeys } from "./query-keys";

export function useAuthPassword() {
  return useQuery(authPasswordQuery());
}

export function useSetAuthPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.setAuthPassword(password),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authKeys.password });
      toast.success("Login password updated");
    },
    onError: (e) => toast.error(`Failed to update password: ${String(e)}`),
  });
}
