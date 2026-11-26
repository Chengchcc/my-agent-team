import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { gateTraceQuery } from "./queries";

/** What one gate waits on; read while its scope view is open. */
export function useGateTrace(executionId: string, enabled: boolean) {
  return useQuery({ ...gateTraceQuery(executionId), enabled });
}

/** Opening something marks it looked at. This advances read marks and nothing else. */
export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { actionId?: string; runId?: string; conversationId?: string }) =>
      api.markSeen(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["attention"] }),
  });
}

/** Answer an approval from its scope view: allow once, or deny. */
export function useResolveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { runId: string; callId: string; decision: "allow" | "deny" }) =>
      api.resolveApproval(body.runId, body.callId, body.decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attention"] });
      void qc.invalidateQueries({ queryKey: ["pending-actions"] });
    },
  });
}

/** Decide a workflow gate: a budget gate takes one word, a question gate takes its form's
 *  fields. The caller builds the answer (`gateAnswer`); this only sends it. */
export function useResolveGate(executionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { nodeId: string; answer: Record<string, unknown> }) =>
      api.resolveWorkflowHumanTask(executionId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow-executions-gates"] });
      void qc.invalidateQueries({ queryKey: ["workflow-executions", executionId] });
    },
  });
}

/** Overrule an answer the machine gave (ADR 0075 P4b): the worker is told, in its own room. */
export function useCorrectAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { actionId: string; response: unknown }) =>
      api.correctAttention(body.actionId, body.response),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["attention"] }),
  });
}
