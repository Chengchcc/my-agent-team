export interface RunOpsListItem {
  runId: string;
  threadId: string;
  agentId: string;
  kind: string;
  parentRunId: string | null;
  status: string;
  traceId: string | null;
  startedAt: number;
  endedAt: number | null;
  latestAttemptId: string | null;
  heartbeatAgeMs: number | null;
  runnerTransport: "attached" | "noop" | "detached";
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}

export interface RunOpsDetail {
  run: {
    runId: string;
    threadId: string;
    agentId: string;
    kind: string;
    parentRunId: string | null;
    status: string;
    traceId: string | null;
    startedAt: number;
    endedAt: number | null;
  };
  attempts: Array<{
    attemptId: string;
    heartbeatAt: number | null;
    heartbeatAgeMs: number | null;
    startedAt: number;
    endedAt: number | null;
    transport: string;
  }>;
  eventLog: {
    lastSeq: number | null;
    lastEventType: string | null;
    lastEventAt: number | null;
  };
  ops: Array<{
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
    traceId: string | null;
    ts: number;
  }>;
}

export interface AgentRuntimeStatus {
  agentId: string;
  runner: {
    status: string;
    lastSeenAt: number | null;
    uptimeMs: number;
    activeRunCount: number;
    checkpointerOk: boolean;
    workspaceOk: boolean;
    lastError: string | null;
  };
  surfaces: Record<
    string,
    {
      status: string;
      lastSeenAt: number | null;
      lastError: string | null;
      counters: Record<string, number>;
    }
  >;
}

const BASE = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

export async function fetchOpsRuns(params?: {
  agentId?: string;
  status?: string;
  limit?: number;
}): Promise<RunOpsListItem[]> {
  const url = new URL("/api/ops/runs", BASE);
  if (params?.agentId) url.searchParams.set("agentId", params.agentId);
  if (params?.status) url.searchParams.set("status", params.status);
  if (params?.limit) url.searchParams.set("limit", String(params.limit));
  const res = await fetch(url);
  return res.json();
}

export async function fetchOpsRunDetail(
  runId: string,
): Promise<RunOpsDetail | null> {
  const res = await fetch(`/api/ops/runs/${runId}`);
  if (!res.ok) return null;
  return res.json();
}

export async function opsCancelRun(
  runId: string,
): Promise<{ ok: boolean; state: string }> {
  const res = await fetch(`/api/ops/runs/${runId}/cancel`, { method: "POST" });
  return res.json();
}

export async function opsRecoverRun(
  runId: string,
): Promise<{ state: string }> {
  const res = await fetch(`/api/ops/runs/${runId}/recover`, { method: "POST" });
  return res.json();
}

export async function fetchAgentRuntime(
  agentId: string,
): Promise<AgentRuntimeStatus | null> {
  const res = await fetch(`/api/ops/agents/${agentId}/runtime`);
  if (!res.ok) return null;
  return res.json();
}
