import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const evalKeys = {
  all: ["evals"] as const,
  suites: () => [...evalKeys.all, "suites"] as const,
  suite: (suiteId: string) => [...evalKeys.all, "suite", suiteId] as const,
  runs: (params?: {
    suiteId?: string;
    targetKind?: "skill" | "workflow" | "agent";
    targetRef?: string;
  }) =>
    [
      ...evalKeys.all,
      "runs",
      params?.suiteId ?? "",
      params?.targetKind ?? "",
      params?.targetRef ?? "",
    ] as const,
  runDetail: (evalRunId: string) => [...evalKeys.all, "run", evalRunId] as const,
  diff: (baseline: string, candidate: string) =>
    [...evalKeys.all, "diff", baseline, candidate] as const,
  feedback: (params?: { runId?: string; workflowExecutionId?: string }) =>
    [...evalKeys.all, "feedback", params?.runId ?? "", params?.workflowExecutionId ?? ""] as const,
};

export function evalSuitesQuery() {
  return queryOptions({
    queryKey: evalKeys.suites(),
    queryFn: () => api.listEvalSuites(),
  });
}

export function evalSuiteDetailQuery(suiteId: string) {
  return queryOptions({
    queryKey: evalKeys.suite(suiteId),
    queryFn: () => api.getEvalSuite(suiteId),
  });
}

export function evalRunsQuery(params?: {
  suiteId?: string;
  targetKind?: "skill" | "workflow" | "agent";
  targetRef?: string;
  limit?: number;
}) {
  return queryOptions({
    queryKey: evalKeys.runs(params),
    queryFn: () => api.listEvalRuns(params),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === "running") ? 3000 : false,
  });
}

export function evalRunDetailQuery(evalRunId: string) {
  return queryOptions({
    queryKey: evalKeys.runDetail(evalRunId),
    queryFn: () => api.getEvalRun(evalRunId),
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? 2500 : false),
  });
}

export function evalRunDiffQuery(baseline: string, candidate: string) {
  return queryOptions({
    queryKey: evalKeys.diff(baseline, candidate),
    queryFn: () => api.diffEvalRuns(baseline, candidate),
  });
}

export function useEvalSuites() {
  return useQuery(evalSuitesQuery());
}

export function useEvalRuns(params?: {
  suiteId?: string;
  targetKind?: "skill" | "workflow" | "agent";
  targetRef?: string;
  limit?: number;
}) {
  return useQuery(evalRunsQuery(params));
}

export function useRunFeedback(params?: { runId?: string; workflowExecutionId?: string }) {
  return useQuery({
    queryKey: evalKeys.feedback(params),
    queryFn: () => api.listRunFeedback(params),
    enabled: Boolean(params?.runId || params?.workflowExecutionId),
  });
}
