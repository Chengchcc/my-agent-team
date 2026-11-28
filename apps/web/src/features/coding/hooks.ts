import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  api,
  type CodingHarness,
  type CodingTerminalRow,
  type CodingWorkspaceRow,
} from "@/lib/api";
import {
  codingKeys,
  codingTerminalsQuery,
  codingWorkspacesQuery,
  codingWorktreeDiffQuery,
} from "./queries";

export function useCodingTerminals() {
  return useQuery(codingTerminalsQuery());
}

export function useCodingTerminalsList(): CodingTerminalRow[] {
  const { data } = useCodingTerminals();
  return data?.terminals ?? [];
}

export function useCodingWorkspaces() {
  return useQuery(codingWorkspacesQuery());
}

export function useCodingWorkspacesList(): CodingWorkspaceRow[] {
  const { data } = useCodingWorkspaces();
  return data?.workspaces ?? [];
}

export function useCodingWorktreeDiff(
  projectId: string | null,
  workspaceId: string | null,
  enabled: boolean,
) {
  return useQuery({
    ...codingWorktreeDiffQuery(projectId ?? "", workspaceId ?? ""),
    enabled: enabled && projectId !== null && workspaceId !== null,
  });
}

function useTerminalMutation<T, R>(mutationFn: (arg: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: codingKeys.all }),
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

export function useLaunchHarness() {
  return useTerminalMutation((input: { id: string; harness?: CodingHarness }) =>
    api.launchHarnessInTerminal(input.id, input.harness),
  );
}

export function useLaunchOma() {
  return useTerminalMutation((id: string) => api.launchOmaInTerminal(id));
}
