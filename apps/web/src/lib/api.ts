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
  const url = `/bff/${path}`;
  const res = await fetch(url, {
    method: opts?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    signal: opts?.signal,
  });

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

// ── Typed API ──

export const api = {
  // Agents
  listAgents: () => apiFetch<AgentRow[]>("api/agents"),
  getAgent: (id: string) => apiFetch<AgentRow>(`api/agents/${id}`),
  createAgent: (body: unknown) =>
    apiFetch<AgentRow>("api/agents", { method: "POST", body }),
  updateAgent: (id: string, body: unknown) =>
    apiFetch<AgentRow>(`api/agents/${id}`, { method: "PATCH", body }),
  archiveAgent: (id: string) =>
    apiFetch<void>(`api/agents/${id}`, { method: "DELETE" }),
  getIdentity: (id: string) =>
    apiFetch<IdentityData>(`api/agents/${id}/identity`),

  // Threads
  listThreads: (agentId: string) =>
    apiFetch<ThreadRow[]>(`api/agents/${agentId}/threads`),
  getThread: (id: string) => apiFetch<ThreadRow>(`api/threads/${id}`),
  createThread: (agentId: string, body?: { title?: string }) =>
    apiFetch<ThreadRow>(`api/agents/${agentId}/threads`, {
      method: "POST",
      body,
    }),
  updateThread: (id: string, body: { title?: string }) =>
    apiFetch<ThreadRow>(`api/threads/${id}`, { method: "PATCH", body }),
  deleteThread: (id: string) =>
    apiFetch<void>(`api/threads/${id}`, { method: "DELETE" }),
  getMessages: (threadId: string) =>
    apiFetch<{ threadId: string; messages: Message[] | null }>(
      `api/threads/${threadId}/messages`,
    ),

  // Runs
  getCurrentRun: (threadId: string) =>
    apiFetch<RunMeta | null>(`api/threads/${threadId}/current-run`),
  startRun: (threadId: string, input: string) =>
    apiFetch<{ runId: string; attemptId: string }>(
      `api/threads/${threadId}/runs`,
      { method: "POST", body: { input } },
    ),
  getRun: (runId: string) => apiFetch<RunMeta>(`api/runs/${runId}`),
  cancelRun: (runId: string) =>
    apiFetch<void>(`api/runs/${runId}/cancel`, { method: "POST" }),
  resumeRun: (runId: string, approved: boolean, message?: string) =>
    apiFetch<{ runId: string; attemptId: string }>(
      `api/runs/${runId}/resume`,
      { method: "POST", body: { approved, message } },
    ),
};
