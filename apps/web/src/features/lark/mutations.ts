import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { larkKeys } from "./queries";

/** Opens the setup wizard's session for a PA's Lark bot. The wizard itself —
 *  the QR code, the wait for the authorization — is the agent's Lark tab, which
 *  reads the session from the surface view; this only starts it and refreshes
 *  that view, so there is one wizard and one state machine. */
export function useLarkSetup(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { botDisplayName?: string }) => api.larkSetup(agentId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: larkKeys.surface(agentId) }),
  });
}
