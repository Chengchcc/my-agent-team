import { client, unwrap } from "./client";

// ── Types derived from API treaty (single source: backend App type) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiReturn<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

export type AgentRunStatus =
  | "running"
  | "waiting"
  | "commit_failed"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";
/** What a proposal is about. Mirrors the backend's `ProposalKind`. */
export type ProposalKindName =
  | "agent_config"
  | "workflow_definition"
  | "project_creation"
  | "project_update";
export type PendingProposalRow = NonNullable<ApiReturn<typeof api.getPendingProposal>["proposal"]>;

export type ProjectRow = ApiReturn<typeof api.listProjects>["projects"][number];
export type CodingTerminalRow = ApiReturn<typeof api.listCodingTerminals>["terminals"][number];
export type CodingWorkspaceRow = ApiReturn<typeof api.listCodingWorkspaces>["workspaces"][number];
export type CodingHarness = "oma" | "claude" | "pi" | "omp";
export type LarkSetupSession = ApiReturn<typeof api.larkSetup>;
export type AgentRow = ApiReturn<typeof api.listAgents>[number] & {
  enabled?: boolean;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  projects?: string[];
};
export type AgentRunDetail = ApiReturn<typeof api.getAgentRun>;
export type AgentRuntimeStatus = ApiReturn<typeof api.getAgentRuntime>;
export type SurfaceOpsItem = ApiReturn<typeof api.listSurfaces>[number];
export type ConversationSnapshot = ApiReturn<typeof api.listConversations>[number];
export type SavedItem = ApiReturn<typeof api.listSaved>["saved"][number];
export type ReminderRow = ApiReturn<typeof api.listReminders>["reminders"][number];
export type SettingsMap = ApiReturn<typeof api.getSettings>["settings"];
export type ProviderInfo = {
  id: string;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
};
export type McpServerRow = ApiReturn<typeof api.listMcpServers>["mcpServers"][number];
export type PendingInput = ApiReturn<typeof api.listConversationInputs>["inputs"][number];
export type TelemetrySummary = {
  since: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  avgDurationMs: number;
  recent: Array<{
    runId: string;
    status: string;
    modelId: string;
    createdAt: number;
    durationMs: number | null;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byAgent: Array<{
    agentId: string;
    runs: number;
    completed: number;
    failed: number;
    successRate: number | null;
  }>;
  failures: Array<{
    runId: string;
    agentId: string;
    status: string;
    modelId: string;
    createdAt: number;
    durationMs: number | null;
    inputTokens: number;
    outputTokens: number;
    error: string | null;
  }>;
  costByHour: Array<{
    hour: number;
    costUsd: number;
    tokens: number;
  }>;
  byModel: Array<{
    modelId: string;
    runs: number;
    completed: number;
    failed: number;
    costUsd: number;
    tokens: number;
  }>;
  successRateByDay: Array<{
    dayStart: number;
    runs: number;
    completed: number;
    failed: number;
    successRate: number | null;
  }>;
  durationByDay: Array<{
    dayStart: number;
    runs: number;
    avgDurationMs: number | null;
  }>;
  failureCauses: Array<{
    cause: string;
    count: number;
  }>;
  spinningRuns: Array<{
    runId: string;
    status: string;
    modelId: string;
    toolCalls: number;
    durationMs: number | null;
    outputTokens: number;
  }>;
};

export type ChatModelOverride = {
  backendKind: string;
  modelId: string;
  /** Which model the named harness runs, in its own vocabulary (the run's
   *  BackendModelRef.harnessModel). Undefined = the harness's own default. */
  harnessModel?: string;
  reasoningEffort?: "none" | "low" | "high" | "max";
};

export type SystemInfo = ApiReturn<typeof api.getSystemInfo>;
export type WorkflowDefinitionRow = ApiReturn<
  typeof api.listWorkflowDefinitions
>["definitions"][number];

/** Extract fork source ID from a conversation snapshot (null when not a fork). */
export function getForkSourceId(conv: ConversationSnapshot): string | null {
  return typeof conv.forkSource === "string" ? conv.forkSource : null;
}

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
  // Lark surface read model: the ONE answer to "can this agent talk to Lark
  // right now" (status + issue + health + which actions are real).
  larkSurface: (id: string) => unwrap(client.api.agents({ id }).lark.get()),
  // Lark setup
  larkSetup: (id: string, body: { botDisplayName?: string; brand?: "feishu" | "lark" }) =>
    unwrap(client.api.agents({ id }).lark.setup.post(body)),
  larkSetupStatus: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).get()),
  larkSetupCancel: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).delete()),
  // Saved bookmarks (raft absorption)
  setSaved: (conversationId: string, seq: number, saved: boolean) =>
    unwrap(
      client.api
        .conversations({ id: conversationId })
        .messages({ seq: String(seq) })
        .saved.post({
          saved,
        }),
    ),
  listSaved: () => unwrap(client.api.saved.get()),
  // Reminders
  listReminders: (conversationId?: string) =>
    unwrap(
      client.api.reminders.get({
        query: conversationId ? { conversationId } : undefined,
      }),
    ),
  createReminder: (body: { conversationId: string; text: string; fireAt: number }) =>
    unwrap(client.api.reminders.post(body)),
  snoozeReminder: (id: string, fireAt: number) =>
    unwrap(client.api.reminders({ id }).snooze.post({ fireAt })),
  cancelReminder: (id: string) => unwrap(client.api.reminders({ id }).delete()),
  // Conversations
  listConversations: (
    filter?: string | { agentId?: string; requirementId?: string; projectId?: string },
    signal?: AbortSignal,
  ) => {
    const query =
      typeof filter === "string"
        ? { agentId: filter }
        : filter && Object.keys(filter).length > 0
          ? filter
          : undefined;
    return unwrap(
      client.api.conversations.get({
        ...(query ? { query } : {}),
        ...(signal ? { fetch: { signal } } : {}),
      }),
    );
  },
  createConversation: (body: {
    conversationId?: string;
    projectId?: string;
    agentId: string;
    origin?: string;
  }) => unwrap(client.api.conversations.post(body)),
  getConversation: (id: string, signal?: AbortSignal) =>
    unwrap(client.api.conversations({ id }).get(signal ? { fetch: { signal } } : undefined)),
  /** Anchored comment (raft absorption): posts into the conversation with
   *  the readable prefix baked server-side. */
  postArtifactComment: (id: string, body: { url: string; anchor: unknown; text: string }) =>
    unwrap(client.api.conversations({ id })["artifact-comments"].post(body)),
  postConversationMessage: (
    id: string,
    body: {
      /** The two shapes the writer understands: plain text, or ContentBlock
       *  objects (text + image attachments). */
      content: string | Array<Record<string, unknown>>;
      mode?: "normal" | "steer" | "follow_up";
      model?: ChatModelOverride;
      trigger?: boolean;
    },
  ) => unwrap(client.api.conversations({ id }).messages.post(body)),
  listConversationInputs: (id: string) => unwrap(client.api.conversations({ id }).inputs.get()),
  steerConversationInput: (id: string, inputId: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).steer.post()),
  updateConversationInput: (id: string, inputId: string, text: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).patch({ text })),
  cancelConversationInput: (id: string, inputId: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).cancel.post()),
  deleteConversation: (id: string) => unwrap(client.api.conversations({ id }).delete()),
  clearConversation: (id: string) => unwrap(client.api.conversations({ id }).clear.post({})),
  compactConversation: (id: string) => unwrap(client.api.conversations({ id }).compact.post({})),
  updateConversation: (id: string, body: { title?: string }) =>
    unwrap(client.api.conversations({ id }).patch(body)),
  searchConversations: (q: string) => unwrap(client.api.conversations.search.get({ query: { q } })),
  exportConversation: async (id: string) => {
    const resp = await fetch(`/api/bff/api/conversations/${id}/export`, { credentials: "include" });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    return resp.text();
  },
  // Ops — Agent Run is the only execution identity
  /** ADR 0075 P4b: correct a machine answer to a request. */
  correctAttention: (actionId: string, response: unknown) =>
    unwrap(client.api.attention({ actionId }).correct.post({ response } as never)),
  /** ADR 0074 S3: the wiki (read-only over HTTP — writes go through tools). */
  listWikiPages: () => unwrap(client.api.wiki.pages.get()),
  getWikiPage: (path: string) => unwrap(client.api.wiki.page.get({ query: { path } })),
  queryWiki: (text: string) => unwrap(client.api.wiki.query.get({ query: { text } })),
  wikiLint: () => unwrap(client.api.wiki.lint.get()),
  graphWiki: () => unwrap(client.api.wiki.graph.get()),
  wikiBacklinks: (path: string) => unwrap(client.api.wiki.backlinks.get({ query: { path } })),
  /** ADR 0074 + ADR 0082: tracked work items (requirements). */
  listRequirements: (filter?: { closed?: "1"; projectId?: string; conversationId?: string }) =>
    unwrap(client.api.requirements.get(filter ? { query: filter } : undefined)),
  getRequirement: (id: string) => unwrap(client.api.requirements({ id }).get()),
  updateRequirement: (id: string, body: Record<string, unknown>) =>
    unwrap(client.api.requirements({ id }).patch(body)),
  listAgentRuns: (params?: {
    status?: AgentRunStatus;
    agentId?: string;
    conversationId?: string;
    /** ADR 0066: the runs a given run dispatched (Lark card → front desk run
     *  page → the worker's own record). */
    parentRunId?: string;
    limit?: number;
    /** React Query aborts a cancelled query; without this the request runs on
     *  and its response lands in a component that is gone (audit B5). */
    signal?: AbortSignal;
  }) =>
    unwrap(
      client.api["agent-runs"].get({
        query: params
          ? {
              status: params.status,
              agentId: params.agentId,
              conversationId: params.conversationId,
              // This key was accepted and then never sent: `Dispatched units`
              // asked for a run's children and got the newest runs in the
              // console (audit 2026-11-24 — the page was right, the request
              // was not).
              parentRunId: params.parentRunId,
              limit: params.limit != null ? String(params.limit) : undefined,
            }
          : undefined,
        ...(params?.signal ? { fetch: { signal: params.signal } } : {}),
      }),
    ),
  getAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).get()),
  cancelAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).cancel.post()),
  resolveApproval: (
    runId: string,
    callId: string,
    decision: "allow" | "allow_always" | "deny" | "deny_always",
  ) =>
    unwrap(
      client.api["agent-runs"]({ runId }).approval.post({
        callId,
        decision,
      }),
    ),
  // ADR 0061: the attention axis. Reading is free; `seen` only advances read
  // marks, and drafts never touch execution state.
  attention: (signal?: AbortSignal) =>
    unwrap(client.api.attention.get(signal ? { fetch: { signal } } : undefined)),
  markSeen: (body: { actionId?: string; runId?: string; conversationId?: string }) =>
    unwrap(client.api.attention.seen.post(body)),
  getAskDraft: (query: { runId: string; callId: string }) =>
    unwrap(client.api.attention.draft.get({ query })),
  saveAskDraft: (body: { runId: string; callId: string; body: string }) =>
    unwrap(client.api.attention.draft.put(body)),
  getUsageSummary: (scope: { conversationId?: string; agentId?: string }) =>
    unwrap(
      client.api.usage.summary.get({
        query:
          scope.conversationId || scope.agentId
            ? {
                conversationId: scope.conversationId || undefined,
                agentId: scope.agentId || undefined,
              }
            : undefined,
      }),
    ),
  getAgentRuntime: (agentId: string) =>
    unwrap(client.api.ops.agents({ id: agentId }).runtime.get()),
  listSurfaces: () => unwrap(client.api.ops.surfaces.get()),
  getTelemetrySummary: (since?: number) =>
    fetch(`/api/bff/telemetry/summary${since ? `?since=${since}` : ""}`, {
      credentials: "include",
    }).then((r) => r.json()) as Promise<TelemetrySummary>,
  getRunTelemetry: (runId: string) =>
    fetch(`/api/bff/agent-runs/${runId}/telemetry`, { credentials: "include" }).then((r) =>
      r.json(),
    ),
  // Projects
  listProjects: () => unwrap(client.api.projects.get()),
  getProject: (id: string) => unwrap(client.api.projects({ id }).get()),
  listProjectWorktrees: (id: string) => unwrap(client.api.projects({ id }).worktrees.get()),
  projectWorktreeDiff: (id: string, workspaceId: string) =>
    unwrap(client.api.projects({ id }).worktrees({ workspaceId }).diff.get()),
  createProject: (body: { name: string; repoUrl?: string; defaultBranch?: string }) =>
    unwrap(client.api.projects.post(body)),
  updateProject: (
    id: string,
    body: {
      name?: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
    },
  ) => unwrap(client.api.projects({ id }).patch(body)),
  deleteProject: (id: string) => unwrap(client.api.projects({ id }).delete()),
  // Coding terminals & workspaces (Herdr-style worktree PTYs)
  listCodingWorkspaces: (signal?: AbortSignal) =>
    unwrap(client.api.coding.workspaces.get(signal ? { fetch: { signal } } : undefined)),
  listCodingTerminals: (signal?: AbortSignal) =>
    unwrap(client.api.coding.terminals.get(signal ? { fetch: { signal } } : undefined)),
  spawnCodingTerminal: (body: Parameters<typeof client.api.coding.terminals.post>[0]) =>
    unwrap(client.api.coding.terminals.post(body)),
  closeCodingTerminal: (id: string) => unwrap(client.api.coding.terminals({ id }).delete()),
  respawnCodingTerminal: (id: string) => unwrap(client.api.coding.terminals({ id }).respawn.post()),
  launchHarnessInTerminal: (id: string, harness?: CodingHarness) =>
    unwrap(client.api.coding.terminals({ id }).launch.post(harness ? { harness } : {})),
  launchOmaInTerminal: (id: string) =>
    unwrap(client.api.coding.terminals({ id })["launch-oma"].post()),
  codingWsTicket: () => unwrap(client.api.coding["ws-ticket"].post()),
  // Skill packs
  listSkillPacks: () => unwrap(client.api["skill-packs"].get()),
  getSkillPackSkills: (id: string) => unwrap(client.api["skill-packs"]({ id }).skills.get()),
  getSkillPackFiles: (id: string, path?: string) =>
    unwrap(client.api["skill-packs"]({ id }).files.get({ query: path ? { path } : undefined })),
  searchSkillPack: (id: string, q: string) =>
    unwrap(client.api["skill-packs"]({ id }).search.get({ query: { q } })),
  installSkillPackGit: (body: { name: string; description: string; url: string; ref?: string }) =>
    unwrap(client.api["skill-packs"].git.post(body)),
  uploadSkillPackZip: (body: { name: string; description: string; file: File }) =>
    unwrap(client.api["skill-packs"].upload.post(body)),
  syncSkillPack: (id: string, confirm = false) =>
    unwrap(client.api["skill-packs"]({ id }).sync.post({ confirm })),
  deleteSkillPack: (id: string) => unwrap(client.api["skill-packs"]({ id }).delete()),
  getAgentSkillPacks: (agentId: string) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].get()),
  setAgentSkillPacks: (agentId: string, body: { packIds: string[] }) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].put(body)),
  // Settings
  getSettings: () => unwrap(client.api.settings.get()),
  getSystemInfo: () => unwrap(client.api.settings.system.get()),
  updateSetting: (key: string, value: unknown) =>
    unwrap(client.api.settings({ key }).put({ value })),
  currentUser: async () => {
    const r = await fetch("/api/auth/session", { credentials: "include" });
    if (!r.ok) throw new Error("Session expired");
    return (await r.json()) as { userId: string };
  },
  // MCP catalog (ADR 0022, direct fetch - global routes)
  listMcpServers: () =>
    fetch("/api/bff/mcp-servers", { credentials: "include" }).then((r) => r.json()),
  getMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, { credentials: "include" }).then((r) => r.json()),
  createMcpServer: (body: {
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    url?: string;
  }) =>
    fetch("/api/bff/mcp-servers", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  updateMcpServer: (
    serverId: string,
    body: {
      name?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      url?: string;
    },
  ) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  testMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}/test`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json()),
  getMcpToolCatalog: (serverId: string) =>
    unwrap(client.api["mcp-servers"]({ serverId }).tools.get()),
  invokeMcpTool: (serverId: string, body: { tool: string; args?: Record<string, unknown> }) =>
    fetch(`/api/bff/mcp-servers/${serverId}/tools/invoke`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  restartMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}/restart`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json()),
  resolveHumanTasks: (decisions: Array<{ executionId: string; nodeId: string }>) =>
    fetch(`/api/bff/workflow-executions/human-tasks/batch-resolve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    }).then((r) => r.json()),
  getSystemMetrics: () => unwrap(client.api.ops["system-metrics"].get()),
  deleteMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "DELETE",
      credentials: "include",
    }).then((r) => r.ok),
  // Workspace (read-only file browser, ADR 0003)
  listWorkspaceEntries: (agentId: string, path: string) =>
    fetch(`/api/bff/agents/${agentId}/workspace/entries?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    }).then((r) => r.json()),
  readWorkspaceFile: (agentId: string, path: string) =>
    fetch(`/api/bff/agents/${agentId}/workspace/file?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    }).then((r) => r.json()),
  // Harnesses (direct fetch, same reason as listModels). The harness axis is
  // its own list: a harness is not a model (ADR 0040 decision 7), and each one
  // declares the models it can run. Mirror of the backend's
  // HarnessCatalogEntry - keep both in sync (e2e-contract-rules).
  listHarnesses: async () => {
    const resp = await fetch("/api/bff/harnesses", { credentials: "include" });
    return (await resp.json()) as {
      harnesses: Array<{
        key: string;
        name: string;
        models: Array<{ value: string; name: string }>;
        currentModel: string | null;
        error: string | null;
      }>;
    };
  },
  // Models (direct fetch - route not visible to Eden treaty)
  listModels: async () => {
    const resp = await fetch("/api/bff/models", { credentials: "include" });
    return (await resp.json()) as {
      providers: Array<{
        id: string;
        name: string;
        baseUrl?: string;
        models: Array<{
          id: string;
          name: string;
          reasoning: boolean;
          input: string[];
          cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
          contextWindow: number;
          maxTokens: number;
          available?: boolean;
          backendKind: string;
        }>;
      }>;
    };
  },
  // Provider keys added by name (for providers only a models.yml knows)
  listCustomProviderKeys: async () => {
    const resp = await fetch("/api/bff/providers/env", { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as { keys: Array<{ name: string; configured: boolean }> };
  },
  setCustomProviderKey: async (name: string, apiKey: string) => {
    const resp = await fetch(`/api/bff/providers/env/${encodeURIComponent(name)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as { ok: boolean };
  },
  clearCustomProviderKey: async (name: string) => {
    const resp = await fetch(`/api/bff/providers/env/${encodeURIComponent(name)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as { ok: boolean };
  },
  // Login password (direct fetch - route not visible to Eden treaty)
  getAuthPassword: async () => {
    const resp = await fetch("/api/bff/auth/password", { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as { configured: boolean };
  },
  setAuthPassword: async (password: string) => {
    const resp = await fetch("/api/bff/auth/password", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as { ok: boolean };
  },
  // Providers (direct fetch - route not visible to Eden treaty)
  listProviders: async () => {
    const resp = await fetch("/api/bff/providers", { credentials: "include" });
    return (await resp.json()) as { providers: ProviderInfo[] };
  },
  setProvider: async (id: string, body: { apiKey?: string; baseUrl?: string }) => {
    const resp = await fetch(`/api/bff/providers/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Failed to save provider: ${resp.status}`);
    return (await resp.json()) as { ok: boolean; provider: ProviderInfo };
  },
  clearProvider: async (id: string) => {
    const resp = await fetch(`/api/bff/providers/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`Failed to clear provider: ${resp.status}`);
    return (await resp.json()) as { ok: boolean };
  },
  // Conversation fork/undo/replay (direct fetch - new routes)
  forkConversation: async (id: string, fromSeq: number, title?: string) => {
    const resp = await fetch(`/api/bff/conversations/${id}/fork`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSeq, ...(title ? { title } : {}) }),
    });
    return (await resp.json()) as { newConversationId: string };
  },
  undoMessages: async (id: string, count = 1) => {
    const resp = await fetch(`/api/bff/conversations/${id}/undo`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    });
    return (await resp.json()) as { undoneSeqs: number[] };
  },
  replayFromMessage: async (id: string, fromSeq: number, editedContent: string) => {
    const resp = await fetch(`/api/bff/conversations/${id}/replay`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSeq, editedContent }),
    });
    return (await resp.json()) as { newConversationId: string };
  },
  // Workflow
  listWorkflowDefinitions: () => unwrap(client.api["workflow-definitions"].get()),
  getWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).get()),
  saveWorkflowDefinition: (workflowId: string, definition: Record<string, unknown>) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).put({ definition })),
  validateWorkflowDefinition: (body: {
    workflowId?: string;
    definition: Record<string, unknown>;
  }) => unwrap(client.api["workflow-definitions"].validate.post(body)),
  testWorkflowScript: (body: {
    code: string;
    input?: Record<string, unknown>;
    timeoutMs?: number;
  }) => unwrap(client.api["workflow-definitions"]["test-script"].post(body)),
  getWorkflowHistory: (workflowId: string, limit?: number) =>
    unwrap(
      client.api["workflow-definitions"]({ workflowId }).history.get(
        limit !== undefined ? { query: { limit: String(limit) } } : undefined,
      ),
    ),
  revertWorkflowDefinition: (workflowId: string, commit: string) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).revert.post({ commit })),
  dryRunWorkflow: (
    workflowId: string,
    body: {
      input?: Record<string, unknown>;
      mockOutputs?: Record<string, Record<string, unknown>>;
      startNodeId?: string;
      definition?: Record<string, unknown>;
    },
  ) => unwrap(client.api["workflow-definitions"]({ workflowId })["dry-run"].post(body)),
  deleteWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).delete()),
  listWorkflowExecutions: (
    filter?:
      | string
      | {
          workflowId?: string;
          requirementId?: string;
          conversationId?: string;
          projectId?: string;
        },
  ) => {
    const query =
      typeof filter === "string"
        ? { workflowId: filter }
        : filter && Object.keys(filter).length > 0
          ? filter
          : undefined;
    return unwrap(client.api["workflow-executions"].get(query ? { query } : undefined));
  },
  startWorkflowExecution: (body: {
    workflowRef: { repo?: string; path: string };
    input?: Record<string, unknown>;
    artifacts?: string[];
    requirementId?: string;
    conversationId?: string;
    projectId?: string;
  }) => unwrap(client.api["workflow-executions"].post(body)),
  /** Every still-pending proposal (ADR 0040 inbox), optionally of one kind. */
  listPendingProposals: (kind?: ProposalKindName) =>
    unwrap(client.api.proposals.pending.get({ query: kind === undefined ? undefined : { kind } })),
  /** The pending proposal for a target (ADR 0040: an MCP tool proposes, a page adopts), or null
   *  when nothing is waiting. */
  getPendingProposal: (kind: ProposalKindName, targetId: string) =>
    unwrap(client.api.proposals({ kind })({ targetId }).get()),
  /** Say what the page did with it. A second decision on the same proposal is refused (409).
   *  `payload` is what the form saved after the person reviewed the suggestion: the backend
   *  applies exactly that, and the row records it. */
  resolveProposal: (id: string, decision: "adopted" | "discarded", payload?: unknown) => {
    const body = payload === undefined ? { decision } : { decision, payload };
    return unwrap(client.api["proposal-decisions"]({ id }).post(body));
  },
  getWorkflowExecutionTrace: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).trace.get()),
  cancelWorkflowExecution: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).cancel.post({})),
  deleteWorkflowExecution: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).delete()),
  resolveWorkflowHumanTask: (
    executionId: string,
    body: { nodeId: string; answer?: Record<string, unknown> },
  ) => unwrap(client.api["workflow-executions"]({ executionId })["human-task"].post(body)),
  resolveProductAsk: (body: {
    runId: string;
    callId: string;
    answer: {
      answers: Array<{
        id: string;
        selectedValues: string[];
        freeText?: string;
      }>;
    };
  }) =>
    fetch("/api/bff/api/product-tools/ask/resolve", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  listArtifacts: async (
    filter?:
      | string
      | {
          folder?: string;
          requirementId?: string;
          conversationId?: string;
          workflowExecutionId?: string;
          agentId?: string;
          projectId?: string;
          runId?: string;
        },
  ) => {
    const params = new URLSearchParams();
    if (typeof filter === "string") {
      if (filter) params.set("folder", filter);
    } else if (filter) {
      if (filter.folder) params.set("folder", filter.folder);
      if (filter.requirementId) params.set("requirementId", filter.requirementId);
      if (filter.conversationId) params.set("conversationId", filter.conversationId);
      if (filter.workflowExecutionId) params.set("workflowExecutionId", filter.workflowExecutionId);
      if (filter.agentId) params.set("agentId", filter.agentId);
      if (filter.projectId) params.set("projectId", filter.projectId);
      if (filter.runId) params.set("runId", filter.runId);
    }
    const qs = params.toString();
    const r = await fetch(`/api/bff/api/artifacts${qs ? `?${qs}` : ""}`);
    if (!r.ok) throw new Error(`list artifacts failed: ${r.status}`);
    return (await r.json()) as { artifacts: ArtifactMeta[] };
  },
  getArtifactMeta: async (url: string) => {
    const r = await fetch(`/api/bff/api/artifacts/meta?url=${encodeURIComponent(url)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`get artifact meta failed: ${r.status}`);
    const body = (await r.json()) as { artifact: ArtifactMeta };
    return body.artifact;
  },
  uploadArtifact: async (body: {
    folder: string;
    filename: string;
    content: string;
    encoding?: "utf8" | "base64";
  }) => {
    const r = await fetch("/api/bff/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`upload artifact failed: ${r.status}`);
    return (await r.json()) as ArtifactMeta;
  },
  downloadArtifact: async (url: string) => {
    // Query param (not path segment): the artifacts:// URL contains '/'
    // which a path param cannot match, and double-encoding through the BFF
    // can decode %2F back into slashes.
    const r = await fetch(`/api/bff/api/artifacts/download?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error(`download artifact failed: ${r.status}`);
    return (await r.json()) as {
      content: string;
      encoding: string;
      mimeType: string;
      size: number;
    };
  },
  deleteArtifact: async (url: string) => {
    // Query param, same as download: the artifacts:// URL contains '/' which
    // a path segment cannot match (this exact bug broke delete with 404).
    const r = await fetch(`/api/bff/api/artifacts/remove?url=${encodeURIComponent(url)}`, {
      method: "DELETE",
    });
    if (!r.ok) throw new Error(`delete artifact failed: ${r.status}`);
    return (await r.json()) as { ok: boolean };
  },
};

export type EntityLabels = {
  agentName?: string;
  conversationTitle?: string;
  requirementTitle?: string;
  projectName?: string;
  workflowName?: string;
};

export type ArtifactListFilter = {
  folder?: string;
  requirementId?: string;
  conversationId?: string;
  workflowExecutionId?: string;
  agentId?: string;
  projectId?: string;
  runId?: string;
};

export type ArtifactMeta = {
  url: string;
  folder: string;
  filename: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  updatedAt: number;
  source?: {
    runId?: string;
    conversationId?: string;
    requirementId?: string;
    workflowExecutionId?: string;
    agentId?: string;
    projectId?: string;
  };
  labels?: EntityLabels;
};
