export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  opts?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const url = `/api/bff/${path}`;
  const res = await fetch(url, {
    method: opts?.method ?? "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: opts?.method && opts.method !== "GET" ? JSON.stringify(opts.body ?? {}) : undefined,
    signal: opts?.signal,
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, errorBody.error ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

// ── Types ──

export interface LarkConfig {
  enabled: boolean;
  appId: string | null;
  profileRef: string | null;
  botDisplayName: string | null;
  status: "not_configured" | "configured" | "running" | "degraded" | "error";
}

export interface LarkSetupSession {
  setupId: string;
  agentId: string;
  profileRef: string;
  botDisplayName: string | null;
  brand: "feishu" | "lark";
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  url: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface AgentRow {
  id: string;
  name: string;
  template: string | null;
  workspacePath: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl: string | null;
  permissionMode: "ask" | "auto" | "deny";
  maxSteps: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  lark?: LarkConfig;
}

export interface IdentityData {
  soul: string | null;
  user: string | null;
  memories: Array<{ date: string; content: string }>;
}

export interface RunMeta {
  runId: string;
  status: string;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

// ── Conversation types (M14) ──

export interface MemberInfo {
  memberId: string;
  kind: "agent" | "human";
  agentId?: string | null;
  userRef?: string | null;
  displayName?: string | null;
}

export interface ConversationSnapshot {
  conversationId: string;
  triggerMode: "mention";
  hopCount: number;
  title: string | null;
  members: MemberInfo[];
}

export interface LedgerEntry {
  seq: number;
  conversationId: string;
  senderMemberId: string;
  addressedTo: string[];
  kind: "message" | "member.joined" | "member.left";
  content: string;
  ts: number;
}

// ── Typed API ──

export const api = {
  // Agents
  listAgents: () => apiFetch<AgentRow[]>("agents"),
  getAgent: (id: string) => apiFetch<AgentRow>(`agents/${id}`),
  createAgent: (body: unknown) => apiFetch<AgentRow>("agents", { method: "POST", body }),
  updateAgent: (id: string, body: unknown) =>
    apiFetch<AgentRow>(`agents/${id}`, { method: "PATCH", body }),
  archiveAgent: (id: string) => apiFetch<void>(`agents/${id}`, { method: "DELETE" }),
  getIdentity: (id: string) => apiFetch<IdentityData>(`agents/${id}/identity`),
  setIdentity: (id: string, body: { soul?: string; user?: string }) =>
    apiFetch<{ ok: boolean }>(`agents/${id}/identity`, {
      method: "PUT",
      body,
    }),

  // M15.1: Lark setup
  larkSetup: (id: string, body: { botDisplayName?: string; brand?: "feishu" | "lark" }) =>
    apiFetch<LarkSetupSession>(`agents/${id}/lark/setup`, {
      method: "POST",
      body,
    }),
  larkSetupStatus: (id: string, setupId: string) =>
    apiFetch<LarkSetupSession>(`agents/${id}/lark/setup/${setupId}`),
  larkSetupCancel: (id: string, setupId: string) =>
    apiFetch<{ cancelled: boolean }>(`agents/${id}/lark/setup/${setupId}`, {
      method: "DELETE",
    }),

  // Runs
  getRun: (runId: string) => apiFetch<RunMeta>(`runs/${runId}`),
  cancelRun: (runId: string) => apiFetch<void>(`runs/${runId}/cancel`, { method: "POST" }),
  resumeRun: (runId: string, approved: boolean, message?: string) =>
    apiFetch<{ runId: string; attemptId: string }>(`runs/${runId}/resume`, {
      method: "POST",
      body: { approved, message },
    }),

  // Conversations (M14)
  listConversations: (agentId?: string) =>
    apiFetch<ConversationSnapshot[]>(`conversations${agentId ? `?agentId=${agentId}` : ""}`),
  createConversation: (body: {
    conversationId?: string;
    members: Array<{
      memberId?: string;
      kind: "agent" | "human";
      agentId?: string;
      userRef?: string;
      displayName?: string;
    }>;
  }) =>
    apiFetch<{ conversationId: string; members: MemberInfo[] }>("conversations", {
      method: "POST",
      body,
    }),
  getConversation: (id: string) => apiFetch<ConversationSnapshot>(`conversations/${id}`),
  postConversationMessage: (
    id: string,
    body: { senderMemberId: string; addressedTo: string[]; content: unknown },
  ) =>
    apiFetch<{
      seq: number;
      triggeredRuns: Array<{ agentMemberId: string; runId: string }>;
    }>(`conversations/${id}/messages`, { method: "POST", body }),
  addConversationMember: (
    id: string,
    body: {
      memberId: string;
      kind: "agent" | "human";
      agentId?: string;
      displayName?: string;
    },
  ) =>
    apiFetch<{ members: MemberInfo[] }>(`conversations/${id}/members`, {
      method: "POST",
      body,
    }),
  removeConversationMember: (id: string, memberId: string) =>
    apiFetch<{ members: MemberInfo[] }>(`conversations/${id}/members`, {
      method: "DELETE",
      body: { memberId },
    }),
  deleteConversation: (id: string) => apiFetch<void>(`conversations/${id}`, { method: "DELETE" }),

  // M16: Ops observability
  listOpsRuns: (params?: {
    agentId?: string; status?: string; limit?: number;
    transport?: "attached" | "noop" | "detached";
    heartbeat?: "fresh" | "stale" | "none";
    traceId?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.agentId) qs.set("agentId", params.agentId);
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.transport) qs.set("transport", params.transport);
    if (params?.heartbeat) qs.set("heartbeat", params.heartbeat);
    if (params?.traceId) qs.set("traceId", params.traceId);
    const q = qs.toString();
    return apiFetch<RunOpsListItem[]>(`ops/runs${q ? `?${q}` : ""}`);
  },
  getOpsRunDetail: (runId: string) => apiFetch<RunOpsDetail>(`ops/runs/${runId}`),
  opsCancelRun: (runId: string) =>
    apiFetch<CancelRunResult>(`ops/runs/${runId}/cancel`, { method: "POST" }),
  opsRecoverRun: (runId: string) =>
    apiFetch<RecoverRunResult>(`ops/runs/${runId}/recover`, { method: "POST" }),
  getAgentRuntime: (agentId: string) =>
    apiFetch<AgentRuntimeStatus>(`ops/agents/${agentId}/runtime`),
  getTraceOpsDetail: (traceId: string) =>
    apiFetch<TraceOpsDetail>(`ops/traces/${traceId}`),
  listSurfaces: () => apiFetch<SurfaceOpsItem[]>("ops/surfaces"),
};

// ── M16 ops types ──

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
    runId: string; threadId: string; agentId: string; kind: string;
    parentRunId: string | null; status: string; traceId: string | null;
    startedAt: number; endedAt: number | null;
  };
  attempts: Array<{
    attemptId: string; heartbeatAt: number | null; heartbeatAgeMs: number | null;
    startedAt: number; endedAt: number | null; transport: string;
  }>;
  eventLog: { lastSeq: number | null; lastEventType: string | null; lastEventAt: number | null };
  ops: Array<{
    seq: number; kind: string; payload: Record<string, unknown>;
    traceId: string | null; ts: number;
  }>;
}

export interface AgentRuntimeStatus {
  agentId: string;
  heartbeatTimeoutMs: number;
  runner: {
    status: string; lastSeenAt: number | null; uptimeMs: number;
    activeRunCount: number; checkpointerOk: boolean; workspaceOk: boolean;
    lastError: string | null;
  };
  surfaces: Record<string, {
    status: string; lastSeenAt: number | null;
    lastError: string | null; counters: Record<string, number>;
  }>;
}

export interface SurfaceOpsItem {
  agentId: string;
  surface: "lark" | "web";
  status: string;
  lastSeenAt: number | null;
  lastError: string | null;
  counters: Record<string, number>;
}

export interface TraceOpsDetail {
  traceId: string;
  mode: "local" | "otlp";
  runs: RunOpsListItem[];
  events: Array<{
    ts: number;
    runId: string;
    attemptId: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

export type CancelRunResult =
  | { ok: true; state: "abort_sent"; runId: string; attemptId: string }
  | { ok: true; state: "already_terminal"; runId: string; status: string }
  | { ok: true; state: "detached_waiting_reaper"; runId: string; heartbeatAgeMs: number | null }
  | { ok: false; error: "not_found" };

export type RecoverRunResult =
  | { state: "already_terminal"; status: string }
  | { state: "reattached"; attemptId: string }
  | { state: "marked_interrupted"; reason: "heartbeat_timeout" }
  | { state: "waiting"; reason: "heartbeat_fresh_but_transport_detached" };

// ── Error classification ──

export type UiErrorKind = "unauthorized" | "not_found" | "backend_unavailable" | "unknown";

export function classifyError(e: unknown): UiErrorKind {
  if (e instanceof ApiError) {
    if (e.status === 401) return "unauthorized";
    if (e.status === 404) return "not_found";
    if (e.status >= 500) return "backend_unavailable";
  }
  return "unknown";
}

// ── Ops diagnosis types ──

export type RunDiagnosisKind =
  | "running"
  | "heartbeat_stale"
  | "detached_waiting_reaper"
  | "surface_projection_failed"
  | "terminal";

export type DiagnosisOwner =
  | "none"
  | "runner"
  | "backend_runner_link"
  | "surface"
  | "unknown";

export interface RunDiagnosis {
  kind: RunDiagnosisKind;
  owner: DiagnosisOwner;
}
