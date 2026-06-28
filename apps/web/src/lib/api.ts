import type { IssuePriority, IssueStatus } from "@my-agent-team/api-contract";
import type { LedgerEntry, Member } from "@my-agent-team/conversation";
import type { ContentBlock } from "@my-agent-team/message";
import { client, unwrap } from "./client";

export type { IssuePriority, IssueStatus };

// ── Types (interim — keep until Elysia handlers return typed objects instead of Response) ──

export interface ProjectRow {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  autoOrchestrate: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  sessionId: string;
  description: string;
  priority: IssuePriority;
  estimatedCompletionAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type IssueEventKind =
  | "created"
  | "started"
  | "run.started"
  | "run.ended"
  | "deliverable.submitted"
  | "status.advanced"
  | "human.decided";
export interface IssueEvent {
  seq: number;
  issueId: string;
  kind: IssueEventKind;
  payload: Record<string, unknown>;
  ts: number;
}
export interface IssueRunSummary {
  spanId: string;
  fromStatus: string;
  agentId: string;
  createdAt: number;
  status: string;
  endedAt: number | null;
}
export interface CronJobRow {
  cronJobId: string;
  name: string;
  agentId: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}
export interface ColumnConfigRow {
  configId: string;
  projectId: string;
  status: IssueStatus;
  agentId: string;
  promptTemplate: string;
  createdAt: number;
  updatedAt: number;
}
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
  spanId: string;
  status: string;
  startedAt?: number | null;
  endedAt?: number | null;
}
export type { ContentBlock };
export type MemberInfo = Member;
export interface ConversationSnapshot {
  conversationId: string;
  triggerMode: "mention";
  hopCount: number;
  title: string | null;
  members: MemberInfo[];
}
export type { LedgerEntry };

// B2 session types
export interface SessionRow {
  sessionId: string;
  agentId: string;
  spanCount: number;
  lastSpanAt: number | null;
  status: "running" | "done";
}
export interface SessionDetail {
  sessionId: string;
  agentId: string;
  status: "running" | "done";
  spanCount: number;
  spans: SessionSpan[];
}
export interface SessionSpan {
  spanId: string;
  status: string;
  kind: string;
  agentId: string;
  startedAt: number | null;
  endedAt: number | null;
}

// M16 ops types
export interface RunOpsListItem {
  spanId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  kind: string;
  parentSpanId: string | null;
  status: string;
  traceId: string | null;
  startedAt: number;
  endedAt: number | null;
  latestAttemptSeq: number | null;
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}
export interface RunOpsDetail {
  run: {
    spanId: string;
    sessionId: string;
    agentId: string;
    kind: string;
    parentSpanId: string | null;
    status: string;
    traceId: string | null;
    startedAt: number;
    endedAt: number | null;
  };
  attempts: Array<{ attemptSeq: number; startedAt: number; endedAt: number | null }>;
  eventLog: { lastSeq: number | null; lastEventType: string | null; lastEventAt: number | null };
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
  agentName: string;
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
export interface SurfaceOpsItem {
  agentId: string;
  agentName: string;
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
    spanId: string;
    attemptSeq: number | null;
    kind: string;
    payload: Record<string, unknown>;
  }>;
}
export type CancelRunResult =
  | { ok: true; state: "abort_sent"; spanId: string; attemptSeq: number }
  | { ok: true; state: "already_terminal"; spanId: string; status: string }
  | { ok: false; error: "not_found" };
export type RecoverRunResult =
  | { state: "already_terminal"; status: string }
  | { state: "marked_interrupted"; reason: "heartbeat_timeout" }
  | { state: "waiting"; reason: "session_not_found" };
export interface RunInsights {
  spanId: string;
  agentId: string;
  agentName: string;
  root: {
    status: string;
    startedAt: number;
    endedAt: number | null;
    totalLatencyMs: number | null;
    totalCostUsd: number | null;
    unknownCostCalls: number;
    llmCalls: number;
    toolCalls: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheCreate: number;
    slowestCall?: { kind: "llm" | "tool"; step: number; name: string; latencyMs: number };
    failedCall?: { step: number; name: string };
    interruptedAt?: { step: number };
  };
  calls: Array<{
    kind: "llm" | "tool" | "interrupt";
    step: number;
    ts: number;
    model?: string;
    usage?: { input: number; output: number; cacheCreate?: number; cacheRead?: number };
    latencyMs?: number;
    ttftMs?: number | null;
    costUsd?: number | null;
    stopReason?: string;
    name?: string;
    isError?: boolean;
  }>;
  toolBreakdown: Array<{ name: string; count: number; errorCount: number; totalLatencyMs: number }>;
}
export interface InsightsSummary {
  window: { from: number; to: number };
  tokenSeries: Array<{ ts: number; input: number; output: number }>;
  costByAgent: Array<{ agentId: string; agentName: string; costUsd: number | null }>;
  costByModel: Array<{ model: string; costUsd: number | null }>;
  topTools: Array<{ name: string; count: number; errorRate: number }>;
}
export type UiErrorKind = "unauthorized" | "not_found" | "backend_unavailable" | "unknown";
export function classifyError(e: unknown): UiErrorKind {
  if (e instanceof Error && e.name === "ApiError") {
    const ae = e as Error & { status: number };
    if (ae.status === 401) return "unauthorized";
    if (ae.status === 404) return "not_found";
    if (ae.status >= 500) return "backend_unavailable";
  }
  return "unknown";
}
export type RunDiagnosisKind =
  | "running"
  | "heartbeat_stale"
  | "detached_waiting_reaper"
  | "surface_projection_failed"
  | "terminal";
export type DiagnosisOwner = "none" | "runner" | "backend_runner_link" | "surface" | "unknown";
export interface RunDiagnosis {
  kind: RunDiagnosisKind;
  owner: DiagnosisOwner;
}

// ── API client (treaty-based — single source: backend App type) ──

export const api = {
  // Agents
  listAgents: () => unwrap<AgentRow[]>(client.api.agents.get()),
  getAgent: (id: string) => unwrap<AgentRow>(client.api.agents({ id }).get()),
  createAgent: (body: Record<string, unknown>) =>
    unwrap<AgentRow>(client.api.agents.post(body as any)),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    unwrap<AgentRow>(client.api.agents({ id }).patch(body as any)),
  archiveAgent: (id: string) => unwrap<void>(client.api.agents({ id }).delete()),
  getIdentity: (id: string) => unwrap<IdentityData>(client.api.agents({ id }).identity.get()),
  setIdentity: (id: string, body: { soul?: string; user?: string }) =>
    unwrap<{ ok: boolean }>(client.api.agents({ id }).identity.put(body)),
  // Lark setup
  larkSetup: (id: string, body: { botDisplayName?: string; brand?: "feishu" | "lark" }) =>
    unwrap<LarkSetupSession>(client.api.agents({ id }).lark.setup.post(body)),
  larkSetupStatus: (id: string, setupId: string) =>
    unwrap<LarkSetupSession>(client.api.agents({ id }).lark.setup({ setupId }).get()),
  larkSetupCancel: (id: string, setupId: string) =>
    unwrap<{ cancelled: boolean }>(client.api.agents({ id }).lark.setup({ setupId }).delete()),
  // Runs (only resume — used by approval card)
  resumeRun: (spanId: string, approved: boolean, message?: string) =>
    unwrap<{ spanId: string; resumed: boolean }>(
      client.api.runs({ id: spanId }).resume.post({ approved, message }),
    ),
  // Conversations
  listConversations: (agentId?: string) =>
    unwrap<ConversationSnapshot[]>(
      client.api.conversations.get({ query: agentId ? { agentId } : undefined }),
    ),
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
    unwrap<{ conversationId: string; members: MemberInfo[] }>(client.api.conversations.post(body)),
  getConversation: (id: string) =>
    unwrap<ConversationSnapshot>(client.api.conversations({ id }).get()),
  postConversationMessage: (
    id: string,
    body: { senderMemberId: string; addressedTo: string[]; content: unknown },
  ) =>
    unwrap<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; runId: string }> }>(
      client.api.conversations({ id }).messages.post(body),
    ),
  addConversationMember: (
    id: string,
    body: { memberId: string; kind: "agent" | "human"; agentId?: string; displayName?: string },
  ) => unwrap<{ members: MemberInfo[] }>(client.api.conversations({ id }).members.post(body)),
  removeConversationMember: (id: string, memberId: string) =>
    unwrap<{ members: MemberInfo[] }>(client.api.conversations({ id }).members.delete(memberId)),
  deleteConversation: (id: string) => unwrap<void>(client.api.conversations({ id }).delete()),
  // Ops
  listOpsRuns: (params?: { agentId?: string; status?: string; limit?: number; traceId?: string }) =>
    unwrap<RunOpsListItem[]>(client.api.ops.runs.get({ query: params as Record<string, string> })),
  getOpsRunDetail: (spanId: string) =>
    unwrap<RunOpsDetail>(client.api.ops.runs({ id: spanId }).get()),
  listOpsSessions: (params?: { agentId?: string; status?: string; limit?: number }) =>
    unwrap<SessionRow[]>(client.api.ops.sessions.get({ query: params as Record<string, string> })),
  getOpsSessionDetail: (sessionId: string) =>
    unwrap<SessionDetail>(client.api.ops.sessions({ id: sessionId }).get()),
  opsCancelRun: (spanId: string) =>
    unwrap<CancelRunResult>(client.api.ops.runs({ id: spanId }).cancel.post()),
  opsRecoverRun: (spanId: string) =>
    unwrap<RecoverRunResult>(client.api.ops.runs({ id: spanId }).recover.post()),
  getAgentRuntime: (agentId: string) =>
    unwrap<AgentRuntimeStatus>(client.api.ops.agents({ id: agentId }).runtime.get()),
  getTraceOpsDetail: (traceId: string) =>
    unwrap<TraceOpsDetail>(client.api.ops.traces({ id: traceId }).get()),
  listSurfaces: () => unwrap<SurfaceOpsItem[]>(client.api.ops.surfaces.get()),
  getRunInsights: (spanId: string) =>
    unwrap<RunInsights>(client.api.ops.runs({ id: spanId }).insights.get()),
  getInsightsSummary: (range: { from: number; to: number }) =>
    unwrap<InsightsSummary>(
      client.api.ops.insights.summary.get({
        query: { from: String(range.from), to: String(range.to) },
      }),
    ),
  // Projects
  listProjects: () => unwrap<{ projects: ProjectRow[] }>(client.api.projects.get()),
  createProject: (body: {
    name: string;
    repoUrl?: string;
    defaultBranch?: string;
    autoOrchestrate?: boolean;
  }) => unwrap<{ project: ProjectRow }>(client.api.projects.post(body)),
  updateProject: (
    id: string,
    body: {
      name?: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
      autoOrchestrate?: boolean;
    },
  ) => unwrap<{ project: ProjectRow }>(client.api.projects({ id }).patch(body)),
  deleteProject: (id: string) => unwrap<void>(client.api.projects({ id }).delete()),
  // Issues
  getIssueMeta: () => unwrap<{ statuses: IssueStatus[] }>(client.api["issue-meta"].get()),
  listIssues: (projectId?: string) =>
    unwrap<{ issues: IssueRow[] }>(
      client.api.issues.get({ query: projectId ? { projectId } : undefined }),
    ),
  getIssue: (id: string) => unwrap<{ issue: IssueRow }>(client.api.issues({ id }).get()),
  createIssue: (body: {
    projectId: string;
    title: string;
    description?: string;
    priority?: IssuePriority;
    estimatedCompletionAt?: number | null;
  }) => unwrap<{ issue: IssueRow }>(client.api.issues.post(body)),
  updateIssue: (
    id: string,
    body: {
      title?: string;
      description?: string;
      priority?: IssuePriority;
      estimatedCompletionAt?: number | null;
    },
  ) => unwrap<{ issue: IssueRow }>(client.api.issues({ id }).patch(body)),
  deleteIssue: (id: string) => unwrap<void>(client.api.issues({ id }).delete()),
  applyTransition: (id: string, to: IssueStatus) =>
    unwrap<{ issue: IssueRow }>(client.api.issues({ id }).transition.post({ to })),
  reviewDecision: (id: string, body: { decision: "approve" | "reject"; note?: string }) =>
    unwrap<{ issue: IssueRow }>(client.api.issues({ id })["review-decision"].post(body)),
  getIssueDetail: (id: string) =>
    unwrap<{ issue: IssueRow; timeline: IssueEvent[]; runs: IssueRunSummary[] }>(
      client.api.issues({ id }).detail.get(),
    ),
  // Column Configs
  listColumnConfigs: (projectId: string) =>
    unwrap<{ configs: ColumnConfigRow[] }>(
      client.api["column-configs"].get({ query: { projectId } }),
    ),
  upsertColumnConfig: (body: {
    projectId: string;
    status: IssueStatus;
    agentId: string;
    promptTemplate: string;
  }) => unwrap<{ config: ColumnConfigRow }>(client.api["column-configs"].post(body)),
  deleteColumnConfig: (configId: string) =>
    unwrap<void>(client.api["column-configs"]({ id: configId }).delete()),
  // Cron Jobs
  listCronJobs: () => unwrap<{ cronJobs: CronJobRow[] }>(client.api["cron-jobs"].get()),
  createCronJob: (body: {
    name: string;
    agentId: string;
    cronExpr: string;
    prompt?: string;
    timeoutMs?: number;
    maxRetries?: number;
    enabled?: boolean;
  }) => unwrap<{ cronJob: CronJobRow }>(client.api["cron-jobs"].post(body)),
  updateCronJob: (
    id: string,
    body: {
      name?: string;
      agentId?: string;
      cronExpr?: string;
      prompt?: string;
      timeoutMs?: number;
      maxRetries?: number;
    },
  ) => unwrap<{ cronJob: CronJobRow }>(client.api["cron-jobs"]({ id }).patch(body)),
  setCronJobEnabled: (id: string, enabled: boolean) =>
    unwrap<{ cronJob: CronJobRow }>(client.api["cron-jobs"]({ id }).enable.post({ enabled })),
  deleteCronJob: (id: string) => unwrap<void>(client.api["cron-jobs"]({ id }).delete()),
};
