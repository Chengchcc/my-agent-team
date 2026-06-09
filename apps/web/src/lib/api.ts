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
    window.location.href = "/login";
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
}

export interface ThreadRow {
  id: string;
  agentId: string;
  title: string | null;
  kind: "agent_thread" | "conversation";
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
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

  // Threads
  listThreads: (agentId: string) => apiFetch<ThreadRow[]>(`agents/${agentId}/threads`),
  getThread: (id: string) => apiFetch<ThreadRow>(`threads/${id}`),
  createThread: (agentId: string, body?: { title?: string }) =>
    apiFetch<ThreadRow>(`agents/${agentId}/threads`, {
      method: "POST",
      body,
    }),
  updateThread: (id: string, body: { title?: string }) =>
    apiFetch<ThreadRow>(`threads/${id}`, { method: "PATCH", body }),
  deleteThread: (id: string) => apiFetch<void>(`threads/${id}`, { method: "DELETE" }),

  // Runs
  getRun: (runId: string) => apiFetch<RunMeta>(`runs/${runId}`),
  cancelRun: (runId: string) => apiFetch<void>(`runs/${runId}/cancel`, { method: "POST" }),
  resumeRun: (runId: string, approved: boolean, message?: string) =>
    apiFetch<{ runId: string; attemptId: string }>(`runs/${runId}/resume`, {
      method: "POST",
      body: { approved, message },
    }),

  // Conversations (M14)
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
      method: "POST",
      body: { memberId },
    }),
};
