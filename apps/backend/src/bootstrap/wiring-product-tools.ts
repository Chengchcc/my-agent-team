import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Message } from "@chengchenccc/message";
import type { BackendConfig } from "../config.js";
import { type AgentService, createAgentConfigMcpServer } from "../features/agent/index.js";
import type { AgentContextPort } from "../features/agent-context/index.js";
import { answerRefusal } from "../features/agent-run/answer-guard.js";
import { pendingActionId } from "../features/agent-run/domain.js";
import type { AgentRunExecutionService, AgentRunPort } from "../features/agent-run/index.js";
import type { createNotifyDispatcher } from "../features/agent-run/notify-dispatcher.js";
import type { RecallHit } from "../features/agent-run/recall.js";
import type { createAhpChatWriter } from "../features/ahp/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import type { ConversationPort } from "../features/conversation/index.js";
import type { ConversationService } from "../features/conversation/service.js";
import {
  createProductToolsMcpServer,
  createProductToolsService,
  frameBrief,
  frameHandbackInput,
  frameReportInput,
  type ProductToolsService,
  type ProductToolsServiceDeps,
  sqliteProductToolCallAdapter,
} from "../features/product-tools/index.js";
import { createRunTokenRegistry } from "../features/product-tools/run-token-registry.js";
import type { ProjectService } from "../features/project/index.js";
import { pushProjectWorktree } from "../features/project/push.js";
import type { ProposalService } from "../features/proposal/index.js";
import { recall } from "../features/recall/recall.js";
import {
  createReminderService,
  REMINDER_BANNER_PREFIX,
  sqliteReminderAdapter,
} from "../features/reminder/index.js";
import type { RequirementService } from "../features/requirement/index.js";
import type { RuntimeOpsStore } from "../features/runtime-ops/index.js";
import type { SettingsService } from "../features/settings/index.js";
import type { WikiService } from "../features/wiki/index.js";
import { createWorkflowMcpServer } from "../features/workflow/index.js";
import type { createWorkspaceService } from "../features/workspace/service.js";

export interface ProductToolsWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  settingsSvc: SettingsService;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  agentRunPort: AgentRunPort;
  contextPort: AgentContextPort;
  convPort: ConversationPort;
  convSvc: ConversationService;
  artifactService: ArtifactService;
  requirementSvc: RequirementService;
  wikiSvc: WikiService;
  proposalSvc: ProposalService;
  projectSvc: ProjectService;
  workspaceSvc: ReturnType<typeof createWorkspaceService>;
  checkoutOf: (conversationId: string) => {
    requirementId: string | null;
    checkout: { path: string } | null;
  };
  chatWriter: ReturnType<typeof createAhpChatWriter>;
  enabledMcpServers: ReadonlySet<string>;
  recallByRun: Map<string, readonly RecallHit[]>;
  notifyDispatcher: ReturnType<typeof createNotifyDispatcher>;
  onRequestCreated: (input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }) => void;
  injectSteer: (
    branchId: string,
    input: { inputId: string; message: Message },
    opts?: { keepIfIdle?: boolean },
  ) => Promise<void>;
  getAgentRunExecution: () => AgentRunExecutionService | null;
  getWorkflowTools: () => NonNullable<ProductToolsServiceDeps["workflows"]> | null;
}

/** Enabled, non-archived roster as capability cards — read by `team_list`. */
export async function buildRosterCards(
  agentSvc: Pick<AgentService, "list">,
  projectSvc: Pick<ProjectService, "getById">,
) {
  const rows = await agentSvc.list();
  return rows
    .filter((row) => row.archivedAt === null && row.config.enabled)
    .map((row) => ({
      id: row.id,
      name: row.config.name,
      description: row.config.description,
      skills: row.config.skills.map((s) =>
        s.description.length > 0 ? `${s.id}：${s.description}` : s.id,
      ),
      ...(row.config.runtime_config.projects.length > 0
        ? {
            projects: row.config.runtime_config.projects.map((pid) => {
              const project = projectSvc.getById(pid) as { name?: string } | null;
              return { projectId: pid, name: project?.name ?? pid };
            }),
          }
        : {}),
    }));
}

/** ADR 0076: resolve which project a dispatch targets. The room's bound project
 *  wins over brief/instruction text matching, restricted to projects attached to
 *  the target worker. */
export function resolveDispatchProject<T extends { projectId: string; name: string }>(input: {
  attached: readonly string[];
  roomProjectId: string | null;
  getProject: (projectId: string) => T;
  briefObject: string;
  instruction: string;
}): T | null {
  const { attached, roomProjectId, getProject, briefObject, instruction } = input;
  const roomProject =
    roomProjectId !== null && attached.includes(roomProjectId) ? getProject(roomProjectId) : null;
  return (
    roomProject ??
    attached
      .map((pid) => getProject(pid))
      .find((p) => briefObject.includes(p.name) || instruction.includes(p.name)) ??
    null
  );
}

/** ADR 0065 / C2-A: persist human-authorized lessons into the agent's personal
 *  Wiki page (`personal/<agentId>/memories.md`) with deduplication and 3-attempt
 *  optimistic CAS retry. */
export async function rememberLesson(
  wikiSvc: Pick<WikiService, "read" | "patch" | "create">,
  input: { agentId: string; conversationId: string; text: string; todayIso?: string },
): Promise<{ saved: boolean; reason?: string }> {
  const normalized = input.text.replace(/\s+/g, " ").trim();
  if (!normalized) return { saved: false, reason: "empty lesson" };
  const pagePath = `personal/${input.agentId}/memories.md`;
  const source = `conversation:${input.conversationId}`;
  const dateStamp = input.todayIso ?? new Date().toISOString().slice(0, 10);
  const line = `- [${dateStamp}] ${normalized}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = wikiSvc.read(pagePath);
    if (existing) {
      const already = existing.body
        .split("\n")
        .some((row) => row.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, "").trim() === normalized);
      if (already) return { saved: true, reason: "already remembered" };
      const body =
        existing.body.trim() === "" ? line : `${existing.body.replace(/\s+$/, "")}\n${line}`;
      const res = await wikiSvc.patch({
        path: pagePath,
        agentId: input.agentId,
        content: body,
        sources: [source],
        expectedRevision: existing.revision,
      });
      if (res.ok) return { saved: true };
      if (res.reason === "conflict") continue;
      return { saved: false, reason: res.detail };
    }
    const res = await wikiSvc.create({
      path: pagePath,
      agentId: input.agentId,
      title: "Personal Memories",
      content: line,
      sources: [source],
    });
    if (res.ok) return { saved: true };
    if (res.reason === "conflict") continue;
    return { saved: false, reason: res.detail };
  }
  return { saved: false, reason: "concurrent update conflict" };
}

/** Wire ReminderService, ProductToolsService (dispatch, handback, report,
 *  wiki, personal memories, requirements, project push/proposals, worker
 *  steer/cancel), per-run bearer token registry, and the 3 local MCP servers. */
export async function wireProductTools(deps: ProductToolsWiringDeps) {
  const {
    config,
    db,
    ulid,
    settingsSvc,
    opsStore,
    agentSvc,
    agentRunPort,
    contextPort,
    convPort,
    convSvc,
    artifactService,
    requirementSvc,
    wikiSvc,
    proposalSvc,
    projectSvc,
    workspaceSvc,
    checkoutOf,
    chatWriter,
    enabledMcpServers,
    recallByRun,
    notifyDispatcher,
    onRequestCreated,
    injectSteer,
    getAgentRunExecution,
    getWorkflowTools,
  } = deps;

  const rosterCards = () => buildRosterCards(agentSvc, projectSvc);

  // Reminder service must exist before product tools: remind_me /
  // reminder_list / reminder_cancel call it at request time.
  const reminderSvc = createReminderService({
    port: sqliteReminderAdapter(db),
    idGen: ulid,
    deliver: async ({ conversationId, text }) => {
      await convSvc.postMessage({
        conversationId,
        content: `${REMINDER_BANNER_PREFIX}${text}`,
        mode: "normal",
        // ADR 0047: no human authored this run — the reminder tick did.
        authorization: "system",
      });
    },
  });

  const productTools: ProductToolsService = createProductToolsService({
    runPort: agentRunPort,
    // ADR 0080: the dispatcher's risk rides the worker's run.
    setRunRisk: (runId, risk) => agentRunPort.setRunRisk?.(runId, risk),
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid },
    artifactService,
    reminder: {
      create: (input) =>
        reminderSvc.create({
          conversationId: input.conversationId,
          createdBy: input.createdBy,
          text: input.text,
          fireAt: input.fireAt,
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
        }),
      listByAgent: (agentId) => reminderSvc.listByAgent(agentId),
      cancel: (id) => reminderSvc.cancelReminder(id),
    },
    onAskAnswered: (input) => {
      void chatWriter
        .announceHumanInput({ ...input, outcome: "answered" })
        .catch((err) =>
          console.error(`[bootstrap] ask announcement failed for ${input.runId}:`, err),
        );
    },
    recallForRun: (runId) => recallByRun.get(runId) ?? [],
    // ADR 0074 S2: observations (text-answer mismatch) go to the ops log.
    observe: (runId, kind, payload) => opsStore.appendRunEvent(runId, kind, payload),
    // ADR 0075: the dispatcher answers a worker's parked request.
    answerWorkerRequest: async ({ agentId, runId, callId, decision, answer, evidence }) => {
      const actionId = pendingActionId(runId, callId);
      const action = await agentRunPort.getPendingAction(actionId);
      if (action === null) {
        return { ok: false as const, error: `request ${callId} is no longer pending` };
      }
      const refusal = answerRefusal(
        {
          actionId: callId,
          status: action.status,
          owner: action.owner ?? null,
          payload: action.payload,
        },
        agentId,
      );
      if (refusal !== undefined) return { ok: false as const, error: refusal };
      if (action.kind === "approval") {
        if (decision === undefined) {
          return { ok: false as const, error: "an approval needs decision: allow | deny" };
        }
        await getAgentRunExecution()?.resolveApproval(runId, callId, decision);
      } else {
        if (answer === undefined) {
          return { ok: false as const, error: "an ask needs answer" };
        }
        const woke = await productTools.resolveAskDurable(
          runId,
          callId,
          answer as Parameters<typeof productTools.resolveAsk>[2],
        );
        if (!woke) {
          return { ok: false as const, error: `ask ${callId} is not pending or already resolved` };
        }
      }
      await agentRunPort.markActionAnswered?.(actionId, `agent:${agentId}`, evidence);
      return { ok: true as const };
    },
    onRequestCreated,
    // ADR 0076 / ADR 0077: push requirement checkout branch to remote.
    pushProject: async ({ agentId, runId, project, message, note }) => {
      const agent = await agentSvc.getById(agentId).catch(() => null);
      if (agent === null) return { ok: false as const, error: `agent not found: ${agentId}` };
      const named = projectSvc
        .list()
        .find((candidate) => candidate.projectId === project || candidate.name === project);
      if (named === undefined) return { ok: false as const, error: `unknown project: ${project}` };
      if (!agent.config.runtime_config.projects.includes(named.projectId)) {
        return { ok: false as const, error: `${agentId} is not bound to ${named.name}` };
      }
      if (named.repoUrl === null || named.repoUrl === "") {
        return { ok: false as const, error: `project ${named.name} has no remote to push to` };
      }
      const run = await agentRunPort.getRun(runId).catch(() => null);
      const room = checkoutOf(run?.conversationId ?? "");
      const checkout =
        room.requirementId === null
          ? null
          : workspaceSvc.findForRequirement({
              requirementId: room.requirementId,
              projectId: named.projectId,
            });
      if (checkout === null) {
        return {
          ok: false as const,
          error:
            `this run's room has no ${named.name} checkout to hand back ` +
            "(its requirement was never given one for that project); " +
            "dispatch work on that project here first",
        };
      }
      try {
        const pushed = pushProjectWorktree({
          worktree: checkout.path,
          repoUrl: named.repoUrl,
          runId,
          message,
          ...(note !== undefined ? { note } : {}),
          ...(config.projectPushToken !== undefined ? { token: config.projectPushToken } : {}),
          ...(named.defaultBranch !== null ? { defaultBranch: named.defaultBranch } : {}),
          ...(agent.config.name ? { agent: agent.config.name } : {}),
        });
        opsStore.appendRunEvent(runId, "project_delivered", {
          projectId: named.projectId,
          branch: pushed.branch,
          commits: pushed.commits,
          compareUrl: pushed.compareUrl,
        });
        return { ok: true as const, ...pushed };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    roomProjectOf: (conversationId) => {
      const projectId = convPort.getConversation(conversationId)?.projectId ?? null;
      if (projectId === null) return null;
      const project = projectSvc.getById(projectId);
      return { projectId, name: project.name };
    },
    workerProjects: (agentId) => {
      const row = db.query("SELECT config FROM agents WHERE id = ?").get(agentId) as {
        config: string;
      } | null;
      if (row === null) return [];
      try {
        const cfg = JSON.parse(row.config) as { runtime_config?: { projects?: string[] } };
        return cfg.runtime_config?.projects ?? [];
      } catch {
        return [];
      }
    },
    proposeProject: (input) => {
      const proposal = proposalSvc.propose("project_creation", input.name, {
        name: input.name,
        repoUrl: input.repoUrl,
        ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
        ...(input.attachTo !== undefined ? { attachTo: [...input.attachTo] } : {}),
        proposedBy: input.proposedBy,
      });
      return { proposalId: proposal.id };
    },
    proposeProjectUpdate: (input) => {
      const proposal = proposalSvc.propose("project_update", input.projectId, {
        projectId: input.projectId,
        ...input.changes,
        proposedBy: input.proposedBy,
      });
      return { proposalId: proposal.id };
    },
    projects: {
      list: () =>
        projectSvc.list().map((p) => ({
          projectId: p.projectId,
          name: p.name,
          repoUrl: p.repoUrl ?? null,
        })),
      detail: async (ref) => {
        const p = projectSvc.list().find((x) => x.projectId === ref || x.name === ref);
        if (p === undefined) return null;
        const roster = await agentSvc.list();
        const agents = roster
          .filter((a) => a.config.runtime_config.projects.includes(p.projectId))
          .map((a) => ({
            id: a.id,
            name: a.config.name,
            role: a.config.role ?? null,
          }));
        return {
          projectId: p.projectId,
          name: p.name,
          repoUrl: p.repoUrl ?? null,
          defaultBranch: p.defaultBranch ?? null,
          agents,
        };
      },
      attach: async ({ project, agentId, attached }) => {
        const p = projectSvc.list().find((x) => x.projectId === project || x.name === project);
        if (p === undefined) return { ok: false as const, error: `unknown project: ${project}` };
        const agent = await agentSvc.getById(agentId).catch(() => null);
        if (agent === null) return { ok: false as const, error: `unknown member: ${agentId}` };
        const current = agent.config.runtime_config.projects;
        const next = attached
          ? [...new Set([...current, p.projectId])]
          : current.filter((id) => id !== p.projectId);
        if (next.length !== current.length) {
          await agentSvc.update(agentId, { projects: next });
        }
        const rows = await agentSvc.list();
        return {
          ok: true as const,
          agents: rows
            .filter((a) => a.config.runtime_config.projects.includes(p.projectId))
            .map((a) => ({ id: a.id, name: a.config.name })),
        };
      },
    },
    wikiRecall: (text) =>
      wikiSvc
        .query({ text, limit: 3, excludeSections: ["personal"] })
        .map((h) => ({ path: h.path, title: h.title })),
    wiki: {
      read: (path) => wikiSvc.read(path),
      query: (input) => wikiSvc.query(input),
      lint: () => wikiSvc.lint(),
      create: (input) => wikiSvc.create(input),
      patch: (input) => wikiSvc.patch(input),
      addSource: (input) => wikiSvc.addSource(input),
    },
    requirements: {
      create: (input) => requirementSvc.create(input),
      update: (id, patch) => requirementSvc.update(id, patch),
      get: (id) => requirementSvc.get(id),
      list: (includeClosed) => requirementSvc.list(includeClosed),
      linkDispatchedRun: (input) => {
        const pointed = workspaceSvc.currentRequirementOf(input.conversationId);
        const item = requirementSvc.resolveForDispatch({
          ...(input.requirementId !== undefined
            ? { requirementId: input.requirementId }
            : pointed !== null
              ? { requirementId: pointed }
              : {}),
          conversationId: input.conversationId,
          agentId: input.agentId,
          briefTitle: input.briefTitle,
          briefGoal: input.briefGoal,
          ...(input.acceptance !== undefined && input.acceptance !== null
            ? { acceptance: input.acceptance }
            : {}),
        });
        agentRunPort.setRequirementId?.(input.runId, item.requirementId);
        return { requirementId: item.requirementId };
      },
    },
    emitAsk: ({ runId, callId, question }) => {
      getAgentRunExecution()?.broadcastRunEvent(runId, {
        type: "ask_requested",
        payload: { callId, questions: question.questions },
      });
    },
    emitTodo: ({ runId, items }) => {
      getAgentRunExecution()?.broadcastRunEvent(runId, {
        type: "backend.oma.todo_update",
        payload: { items },
      });
    },
    askTimeoutMs: config.askTimeoutMs,
    // ADR 0038: an answered ask whose run lost its live child resume-dispatches.
    onRunWoke: (runId) => {
      void getAgentRunExecution()?.resumeParkedRun(runId);
    },
    // ADR 0047 + ADR 0070 + ADR 0077 room dispatch.
    dispatch: async ({
      fromAgentId,
      conversationId,
      toAgentId,
      instruction,
      brief,
      parentRunId,
      note,
      findings,
      requirementId: namedRequirement,
    }) => {
      const reuse = settingsSvc.get<boolean>("dispatch.reuseChildConversation") ?? true;
      const room = await convSvc.dispatchRoom({
        parentConversationId: conversationId,
        workerAgentId: toAgentId,
        reuse,
      });
      const workerAgent = await agentSvc.getById(toAgentId).catch(() => null);
      const workerRoot = workerAgent?.workspacePath ?? "";
      const attached = workerAgent?.config.runtime_config.projects ?? [];
      const roomProjectId = convPort.getConversation(conversationId)?.projectId ?? null;
      const namedProject = resolveDispatchProject({
        attached,
        roomProjectId,
        getProject: (pid) => projectSvc.getById(pid),
        briefObject: brief.object,
        instruction,
      });
      let workerWorktree: string | null = null;
      if (namedProject !== null) {
        let requirementId = namedRequirement ?? workspaceSvc.currentRequirementOf(conversationId);
        if (
          namedRequirement !== undefined &&
          namedRequirement !== workspaceSvc.currentRequirementOf(conversationId)
        ) {
          workspaceSvc.attachConversation({
            conversationId,
            requirementId: namedRequirement,
          });
        }
        if (requirementId === null) {
          const opened = requirementSvc.create({
            title: brief.object.slice(0, 80) || instruction.slice(0, 80),
            goal: instruction.slice(0, 300) || brief.object,
            projectId: namedProject.projectId,
            originConversationId: conversationId,
            createdByAgentId: fromAgentId,
          });
          requirementId = opened.requirementId;
          workspaceSvc.attachConversation({ conversationId, requirementId });
        }
        const checkout = await workspaceSvc.ensureForRequirement({
          requirementId,
          projectId: namedProject.projectId,
        });
        workerWorktree = checkout.path;
        workspaceSvc.attachConversation({
          conversationId: room.conversationId,
          requirementId,
        });
      }
      const posted = await convSvc.postMessage({
        conversationId: room.conversationId,
        senderMemberId: fromAgentId,
        content: frameBrief({
          fromAgentId,
          brief,
          instruction,
          ...(workerRoot !== ""
            ? {
                workspace: {
                  root: workerRoot,
                  ...(workerWorktree !== null ? { worktree: workerWorktree } : {}),
                },
              }
            : {}),
          ...(note !== undefined ? { note } : {}),
          ...(findings !== undefined ? { findings } : {}),
          meta: {
            conversation: conversationId,
            ...(parentRunId !== undefined ? { "parent-run": parentRunId } : {}),
            "to-agent": toAgentId,
          },
        }),
        mode: "normal",
        authorization: `dispatch:${fromAgentId}`,
        ...(parentRunId ? { parentRunId } : {}),
      });
      const workerName =
        (await agentSvc.getById(toAgentId).catch(() => null))?.config.name ?? toAgentId;
      const head = instruction.length > 80 ? `${instruction.slice(0, 80)}…` : instruction;
      await convSvc.postMessage({
        conversationId,
        senderMemberId: fromAgentId,
        trigger: false,
        content: `→ 已派给 ${workerName}：「${head}」`,
        dispatchTo: { conversationId: room.conversationId },
      });
      const first = posted.triggeredRuns.find((entry) => entry.agentId === toAgentId);
      return {
        agentId: toAgentId,
        runId: first?.runId ?? "",
        inputId: first?.inputId ?? "",
        queued: first?.queued ?? false,
      };
    },
    pickAgent: async (query) => {
      const rows = await agentSvc.list();
      const load = new Map((await agentRunPort.agentLoad()).map((l) => [l.agentId, l]));
      const candidates = rows
        .filter((row) => row.archivedAt === null && row.config.enabled)
        .map((row) => ({
          id: row.id,
          name: row.config.name,
          description: row.config.description,
          skills: row.config.skills.map((s) =>
            s.description === "" ? s.id : `${s.id}：${s.description}`,
          ),
          role: row.config.role ?? null,
          activeRuns: load.get(row.id)?.activeRuns ?? 0,
          lastRunAt: load.get(row.id)?.lastRunAt ?? 0,
        }));
      const result = await recall(
        { workers: async () => candidates },
        { sources: ["capability"], brief: query },
      );
      const hit = result.hits[0];
      const agentId = hit?.meta?.agentId;
      if (hit === undefined || agentId === undefined) return null;
      const field = result.searched.find((s) => s.source === "capability")?.detail;
      return {
        agentId,
        reason: [hit.why, field]
          .filter((p): p is string => typeof p === "string" && p !== "")
          .join("; "),
      };
    },
    // ADR 0052 + ADR 0070 handback: wake dispatcher in the PARENT room.
    handback: async ({ fromAgentId, toAgentId, conversationId, runId, reason, suggestion }) => {
      const currentRun = await agentRunPort.getRun(runId).catch(() => null);
      const parentRun = currentRun?.parentRunId
        ? await agentRunPort.getRun(currentRun.parentRunId).catch(() => null)
        : null;
      const targetConversationId = parentRun?.conversationId ?? conversationId;
      const posted = await convSvc.postMessage({
        conversationId: targetConversationId,
        senderMemberId: fromAgentId,
        content: frameHandbackInput(fromAgentId, reason, suggestion),
        mode: "normal",
        authorization: `handback:${fromAgentId}`,
        parentRunId: runId,
      });
      const first = posted.triggeredRuns.find((entry) => entry.agentId === toAgentId);
      return { runId: first?.runId ?? "", queued: first?.queued ?? false };
    },
    // ADR 0059 D6: mid-run reports never mark result_notified_at (`terminal: false`).
    notifyParent: async ({
      fromAgentId,
      conversationId,
      runId,
      callId,
      purpose,
      text,
      verification,
    }) =>
      notifyDispatcher({
        fromAgentId,
        conversationId,
        runId,
        terminal: false,
        idempotencyKey: `report:${runId}:${callId ?? Date.now()}`,
        text: frameReportInput(fromAgentId, purpose, text, verification),
        wake: purpose !== "progress",
      }),
    // ADR 0065 / C2-A: persist human-authorized lessons into personal Wiki page.
    remember: (input) => rememberLesson(wikiSvc, input),
    // ADR 0059 D6 + ADR 0070: query active runs across both room and child rooms.
    steerWorker: async ({ fromAgentId, conversationId, toAgentId, runId, callId, message }) => {
      const childIds =
        convPort.listChildConversations?.(conversationId).map((c) => c.conversationId) ?? [];
      const scopeIds = [conversationId, ...childIds];
      const active = (
        await agentRunPort.listActiveRunsForConversations(scopeIds).catch(() => [])
      ).find((candidate) => candidate.agentId === toAgentId);
      if (!active) {
        return {
          ok: false,
          error: `${toAgentId} has no running task in this conversation; dispatch a new task instead of steering`,
        };
      }
      const text = `（${fromAgentId} 转达，优先于原任务）\n${message}`;
      const steerBranch = await contextPort.getBranch(active.branchId).catch(() => null);
      const enqueued = await agentRunPort.enqueueAndAcquire({
        conversationId: active.conversationId,
        agentId: toAgentId,
        branchId: active.branchId,
        mode: "steer",
        message: { role: "user", text },
        inputIdempotencyKey: `steer:${runId}:${callId}`,
        runIdempotencyKey: `steer:${runId}:${callId}`,
        deliveryIdempotencyKey: `steer:${runId}:${callId}`,
        defaultModel: active.modelRef,
        configRevision: active.configRevision,
        expectedRevision: steerBranch?.revision ?? active.configRevision,
        authorization: `dispatch:${fromAgentId}`,
        parentRunId: runId,
      });
      if (!enqueued.queued || enqueued.acquired) {
        return {
          ok: false,
          error: `${toAgentId} settled before the steer landed; nothing to steer`,
        };
      }
      try {
        await injectSteer(active.branchId, {
          inputId: enqueued.inputId,
          message: { role: "user", text },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `steer failed: ${(error as Error).message}` };
      }
    },
    cancelWorker: async ({ fromAgentId, conversationId, toAgentId, reason }) => {
      const childIds =
        convPort.listChildConversations?.(conversationId).map((c) => c.conversationId) ?? [];
      const scopeIds = [conversationId, ...childIds];
      const active = (
        await agentRunPort.listActiveRunsForConversations(scopeIds).catch(() => [])
      ).find((candidate) => candidate.agentId === toAgentId);
      if (!active) {
        return { ok: false, error: `${toAgentId} has no running task in this conversation` };
      }
      await convSvc
        .postMessage({
          conversationId,
          senderMemberId: fromAgentId,
          trigger: false,
          content: `（${fromAgentId} 停止了 ${toAgentId} 的工作：${reason}）`,
          authorization: `dispatch:${fromAgentId}`,
          parentRunId: active.runId,
        })
        .catch(() => {});
      try {
        await getAgentRunExecution()?.stop(active.runId);
        return { ok: true, stoppedRunId: active.runId };
      } catch (error) {
        return { ok: false, error: `stop failed: ${(error as Error).message}` };
      }
    },
    listTeam: async () => rosterCards(),
    workflows: {
      list: async () => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.list();
      },
      read: async (id) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.read(id);
      },
      save: async (input) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.save(input);
      },
      delete: async (input) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.delete(input);
      },
      run: async (input) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.run(input);
      },
      status: async (input) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.status(input);
      },
      cancel: async (input) => {
        const w = getWorkflowTools();
        if (!w) throw new Error("workflow tools not ready");
        return w.cancel(input);
      },
    },
  });

  // Per-run bearer registry: tokens are minted at dispatch and revoked at settle.
  const productToolsTokenRegistry = createRunTokenRegistry();

  let productToolsMcp: Awaited<ReturnType<typeof createProductToolsMcpServer>> | null = null;
  if (config.productToolsMcpUrl && enabledMcpServers.has("product-tools")) {
    const mcpUrl = new URL(config.productToolsMcpUrl);
    productToolsMcp = await createProductToolsMcpServer({
      service: productTools,
      tokenRegistry: productToolsTokenRegistry,
      host: mcpUrl.hostname,
      port: Number(mcpUrl.port) || 0,
    });
    console.log(`[bootstrap] product tools MCP listening at ${productToolsMcp.url}`);
  }

  let workflowMcp: Awaited<ReturnType<typeof createWorkflowMcpServer>> | null = null;
  if (enabledMcpServers.has("workflow")) {
    workflowMcp = await createWorkflowMcpServer({
      workflowDir: join(config.dataDir, "workflows"),
      proposals: proposalSvc,
      tokenRegistry: productToolsTokenRegistry,
    });
    console.log(`[bootstrap] workflow MCP listening at ${workflowMcp.url}`);
  }

  let agentConfigMcp: Awaited<ReturnType<typeof createAgentConfigMcpServer>> | null = null;
  if (enabledMcpServers.has("agent")) {
    agentConfigMcp = await createAgentConfigMcpServer({
      readConfig: async (agentId) => {
        const row = await agentSvc.getById(agentId);
        return row?.config ?? null;
      },
      agentExists: (agentId) => agentSvc.exists(agentId),
      proposals: proposalSvc,
      tokenRegistry: productToolsTokenRegistry,
    });
    console.log(`[bootstrap] agent-config MCP listening at ${agentConfigMcp.url}`);
  }

  const closeMcpServers = async (): Promise<void> => {
    await productToolsMcp?.close();
    await workflowMcp?.close();
    await agentConfigMcp?.close();
  };

  return {
    reminderSvc,
    productTools,
    productToolsTokenRegistry,
    workflowMcpUrl: workflowMcp?.url ?? null,
    agentConfigMcpUrl: agentConfigMcp?.url ?? null,
    closeMcpServers,
  };
}
