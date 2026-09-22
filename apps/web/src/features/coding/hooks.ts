import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type CodingTerminalRow } from "@/lib/api";
import { codingKeys, codingTerminalsQuery } from "./queries";

export function useCodingTerminals() {
  return useQuery(codingTerminalsQuery());
}

export function useCodingTerminalsList(): CodingTerminalRow[] {
  const { data } = useCodingTerminals();
  return data?.terminals ?? [];
}

function useTerminalMutation<T>(mutationFn: (arg: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: codingKeys.terminals }),
    onError: (err) =>
      toast.error("Terminal operation failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });
}

export function useSpawnTerminal() {
  return useTerminalMutation((body: Parameters<typeof api.spawnCodingTerminal>[0]) =>
    api.spawnCodingTerminal(body),
  );
}

export function useCloseTerminal() {
  return useTerminalMutation((id: string) => api.closeCodingTerminal(id));
}

export function useRespawnTerminal() {
  return useTerminalMutation((id: string) => api.respawnCodingTerminal(id));
}

export function useLaunchOma() {
  return useTerminalMutation((id: string) => api.launchOmaInTerminal(id));
}
