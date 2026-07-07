import type { LedgerEntry, Member } from "@my-agent-team/conversation";
import type { ContentBlock } from "@my-agent-team/message";
import { client, unwrap } from "./client";

// ── Types derived from API treaty (single source: backend App type) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiReturn<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

export type ProjectRow = ApiReturn<typeof api.listProjects>["projects"][number];
export type CronJobRow = ApiReturn<typeof api.listCronJobs>["cronJobs"][number];
export type LoopRow = ApiReturn<typeof api.listLoops>["loops"][number];
export type LoopDetail = ApiReturn<typeof api.getLoop>["loop"];
export type LarkSetupSession = ApiReturn<typeof api.larkSetup>;
export type AgentRow = ApiReturn<typeof api.listAgents>[number];
export type RunOpsListItem = ApiReturn<typeof api.listOpsRuns>[number];
export type RunOpsDetail = ApiReturn<typeof api.getOpsRunDetail>;
export type AgentRuntimeStatus = ApiReturn<typeof api.getAgentRuntime>;
export type SurfaceOpsItem = ApiReturn<typeof api.listSurfaces>[number];
export type TraceOpsDetail = ApiReturn<typeof api.getTraceOpsDetail>;
export type RunInsights = ApiReturn<typeof api.getRunInsights>;
export type ConversationSnapshot = ApiReturn<typeof api.listConversations>[number];
export type ReviewQueueItem = ApiReturn<typeof api.getWorkToday>["reviewQueue"][number];
export type CreateLoopResult = ApiReturn<typeof api.createLoop>;
export type RefineLoopResult = ApiReturn<typeof api.refineLoop>;
export type ActivateLoopResult = ApiReturn<typeof api.activateLoop>;

export type { ContentBlock };
export type MemberInfo = Member;
export type { LedgerEntry };

export function classifyError(e: unknown) {
  if (e instanceof Error && e.name === "ApiError") {
    const ae = e as Error & { status: number };
    if (ae.status === 401) return "unauthorized";
    if (ae.status === 404) return "not_found";
    if (ae.status >= 500) return "backend_unavailable";
  }
  return "unknown";
}

// ── API client (treaty-based — single source: backend App type) ──

export const api = {
  // Agents
  listAgents: () => unwrap(client.api.agents.get()),
  getAgent: (id: string) => unwrap(client.api.agents({ id }).get()),
  createAgent: (body: Parameters<typeof client.api.agents.post>[0]) =>
    unwrap(client.api.agents.post(body)),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    unwrap(client.api.agents({ id }).patch(body)),
  archiveAgent: (id: string) => unwrap(client.api.agents({ id }).delete()),
  getIdentity: (id: string) => unwrap(client.api.agents({ id }).identity.get()),
  setIdentity: (id: string, body: { soul?: string; user?: string }) =>
    unwrap(client.api.agents({ id }).identity.put(body)),
  // Lark setup
  larkSetup: (id: string, body: { botDisplayName?: string; brand?: "feishu" | "lark" }) =>
    unwrap(client.api.agents({ id }).lark.setup.post(body)),
  larkSetupStatus: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).get()),
  larkSetupCancel: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).delete()),
  // Runs (only resume — used by approval card)
  resumeRun: (spanId: string, approved: boolean, message?: string) =>
    unwrap(client.api.runs({ id: spanId }).resume.post({ approved, message })),
  // Conversations
  listConversations: (agentId?: string) =>
    unwrap(client.api.conversations.get({ query: agentId ? { agentId } : undefined })),
  createConversation: (body: {
    conversationId?: string;
    members: Array<{
      memberId?: string;
      kind: "agent" | "human";
      agentId?: string;
      userRef?: string;
      displayName?: string;
    }>;
  }) => unwrap(client.api.conversations.post(body)),
  getConversation: (id: string) => unwrap(client.api.conversations({ id }).get()),
  postConversationMessage: (
    id: string,
    body: { senderMemberId: string; addressedTo: string[]; content: unknown },
  ) => unwrap(client.api.conversations({ id }).messages.post(body)),
  addConversationMember: (
    id: string,
    body: { memberId: string; kind: "agent" | "human"; agentId?: string; displayName?: string },
  ) => unwrap(client.api.conversations({ id }).members.post(body)),
  removeConversationMember: (id: string, memberId: string) =>
    unwrap(client.api.conversations({ id }).members.delete({ memberId })),
  deleteConversation: (id: string) => unwrap(client.api.conversations({ id }).delete()),
  // Ops
  listOpsRuns: (params?: { agentId?: string; status?: string; limit?: number; traceId?: string }) =>
    unwrap(
      client.api.ops.runs.get({
        query: params
          ? ({
              ...params,
              limit: params.limit != null ? String(params.limit) : undefined,
            } as Record<string, string | undefined>)
          : undefined,
      }),
    ),
  getOpsRunDetail: (spanId: string) => unwrap(client.api.ops.runs({ id: spanId }).get()),
  listOpsSessions: (params?: { agentId?: string; status?: string; limit?: number }) =>
    unwrap(
      client.api.ops.sessions.get({
        query: params
          ? ({
              ...params,
              limit: params.limit != null ? String(params.limit) : undefined,
            } as Record<string, string | undefined>)
          : undefined,
      }),
    ),
  getOpsSessionDetail: (sessionId: string) =>
    unwrap(client.api.ops.sessions({ id: sessionId }).get()),
  opsCancelRun: (spanId: string) => unwrap(client.api.ops.runs({ id: spanId }).cancel.post()),
  opsRecoverRun: (spanId: string) => unwrap(client.api.ops.runs({ id: spanId }).recover.post()),
  getAgentRuntime: (agentId: string) =>
    unwrap(client.api.ops.agents({ id: agentId }).runtime.get()),
  getTraceOpsDetail: (traceId: string) => unwrap(client.api.ops.traces({ id: traceId }).get()),
  listSurfaces: () => unwrap(client.api.ops.surfaces.get()),
  getRunInsights: (spanId: string) => unwrap(client.api.ops.runs({ id: spanId }).insights.get()),
  getInsightsSummary: (range: { from: number; to: number }) =>
    unwrap(
      client.api.ops.insights.summary.get({
        query: { from: String(range.from), to: String(range.to) },
      }),
    ),
  // Projects
  listProjects: () => unwrap(client.api.projects.get()),
  getProject: (id: string) => unwrap(client.api.projects({ id }).get()),
  createProject: (body: {
    name: string;
    repoUrl?: string;
    defaultBranch?: string;
    autoOrchestrate?: boolean;
  }) => unwrap(client.api.projects.post(body)),
  updateProject: (
    id: string,
    body: {
      name?: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
      autoOrchestrate?: boolean;
    },
  ) => unwrap(client.api.projects({ id }).patch(body)),
  deleteProject: (id: string) => unwrap(client.api.projects({ id }).delete()),
  // Cron Jobs
  listCronJobs: () => unwrap(client.api["cron-jobs"].get()),
  createCronJob: (body: {
    name: string;
    agentId: string;
    cronExpr: string;
    prompt?: string;
    timeoutMs?: number;
    maxRetries?: number;
    enabled?: boolean;
  }) => unwrap(client.api["cron-jobs"].post(body)),
  updateCronJob: (
    id: string,
    body: {
      name?: string;
      prompt?: string;
      cronExpr?: string;
      timeoutMs?: number;
      maxRetries?: number;
      enabled?: boolean;
    },
  ) => unwrap(client.api["cron-jobs"]({ id }).patch(body)),
  setCronJobEnabled: (id: string, enabled: boolean) =>
    unwrap(client.api["cron-jobs"]({ id }).enable.post({ enabled })),
  deleteCronJob: (id: string) => unwrap(client.api["cron-jobs"]({ id }).delete()),
  // Loops
  listLoops: () => unwrap(client.api.loops.get()),
  getLoop: (id: string) => unwrap(client.api.loops({ id }).get()),
  createLoop: (body: { name: string; intent?: string; projectId?: string; cronExpr?: string }) =>
    unwrap(client.api.loops.post(body)),
  runLoop: (id: string) => unwrap(client.api.loops({ id }).run.post({})),
  reviewLoopItem: (
    id: string,
    body: {
      verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
      itemId: string;
      feedback?: string;
    },
  ) => unwrap(client.api.loops({ id }).review.post(body)),
  deleteLoop: (id: string) => unwrap(client.api.loops({ id }).delete()),
  activateLoop: (id: string) => unwrap(client.api.loops({ id }).activate.post()),
  refineLoop: (id: string, body: { intent: string }) =>
    unwrap(client.api.loops({ id }).refine.post(body)),
  // Work Today
  getWorkToday: () => unwrap(client.api.work.today.get()),
  // Skill packs
  listSkillPacks: () => unwrap(client.api["skill-packs"].get()),
  getSkillPackSkills: (id: string) => unwrap(client.api["skill-packs"]({ id }).skills.get()),
  getSkillPackFiles: (id: string, path?: string) =>
    unwrap(client.api["skill-packs"]({ id }).files.get({ query: path ? { path } : undefined })),
  installSkillPackGit: (body: { name: string; description: string; url: string; ref?: string }) =>
    unwrap(client.api["skill-packs"].git.post(body)),
  uploadSkillPackZip: (body: { name: string; description: string; file: File }) =>
    unwrap(client.api["skill-packs"].upload.post(body)),
  syncSkillPack: (id: string) => unwrap(client.api["skill-packs"]({ id }).sync.post()),
  deleteSkillPack: (id: string) => unwrap(client.api["skill-packs"]({ id }).delete()),
  getAgentSkillPacks: (agentId: string) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].get()),
  setAgentSkillPacks: (agentId: string, body: { packIds: string[] }) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].put(body)),
};
