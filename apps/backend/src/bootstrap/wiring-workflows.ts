import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInSandbox } from "@chengchenccc/sandbox";
import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";
import type { BackendConfig } from "../config.js";
import { type AgentService, agentModelRef } from "../features/agent/index.js";
import type {
  AgentRunExecutionService,
  AgentRunPort,
  AgentRunService,
} from "../features/agent-run/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import type { ConversationPort } from "../features/conversation/index.js";
import type { ConversationService } from "../features/conversation/service.js";
import type { ProductToolsServiceDeps } from "../features/product-tools/index.js";
import type { ProposalService } from "../features/proposal/index.js";
import { recall } from "../features/recall/recall.js";
import type { RequirementService } from "../features/requirement/index.js";
import type { SettingsService } from "../features/settings/index.js";
import {
  classifyWorkflowRisk,
  createFsWorkflowStore,
  createNodeRunners,
  createWorkflowExecutionService,
  createWorkflowTriggerScheduler,
  resolveConcurrencyPolicy,
  sqliteWorkflowExecutionAdapter,
  WORKFLOW_ID_RE,
  type WorkflowLifecycleNotification,
  workflowRoutes,
} from "../features/workflow/index.js";
import type { createWorkspaceService } from "../features/workspace/service.js";
import type { EntityLabelResolver } from "../infra/entity-labels.js";

export interface WorkflowWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  settingsSvc: SettingsService;
  agentSvc: AgentService;
  agentRunPort: AgentRunPort;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  convPort: ConversationPort;
  conversationService: ConversationService;
  artifactService: ArtifactService;
  requirementSvc: RequirementService;
  workspaceSvc: ReturnType<typeof createWorkspaceService>;
  proposalSvc: ProposalService;
  entityLabels: EntityLabelResolver;
}

/** Wire Agentic Workflow storage (git-backed store), node runners, execution
 *  service (shared Requirement/Worktree, capability pool, room callbacks),
 *  cron trigger scheduler, PA workflow product tools, and HTTP routes. */
export function wireWorkflows(deps: WorkflowWiringDeps) {
  const {
    config,
    db,
    ulid,
    settingsSvc,
    agentSvc,
    agentRunPort,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService,
    artifactService,
    requirementSvc,
    workspaceSvc,
    proposalSvc,
    entityLabels,
  } = deps;

  const workflowDir = join(config.dataDir, "workflows");
  // Builtin showcase: seed sample workflows on first boot before git init so
  // the initial baseline commit captures them.
  {
    mkdirSync(workflowDir, { recursive: true });
    const existing = readdirSync(workflowDir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length === 0 && existsSync(config.workflowShowcaseDir)) {
      for (const f of readdirSync(config.workflowShowcaseDir)) {
        if (f.endsWith(".workflow.json")) {
          copyFileSync(join(config.workflowShowcaseDir, f), join(workflowDir, f));
          console.log(`[bootstrap] seeded showcase workflow: ${f}`);
        }
      }
    }
  }
  const workflowStore = createFsWorkflowStore(workflowDir);

  /** Find a room to deliver workflow lifecycle / circuit-breaker notices when
   *  an execution has no explicit originating conversationId (e.g. cron/webhook). */
  const resolveNotificationRoom = (conversationId: string | null): string | null => {
    if (conversationId && convPort.getConversation(conversationId)) return conversationId;
    const row = db
      .query(
        `SELECT conversation_id FROM conversation
          WHERE origin = 'user' AND parent_conversation_id IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { conversation_id: string } | null;
    return row?.conversation_id ?? null;
  };

  /** ADR 0084 D6: post workflow waiting/terminal notices back to the initiating
   *  room (or default PA room). Ledger-only on success/cancel unless PA started
   *  it; wakes PA on failure or human-gate waiting so nothing dies silently. */
  const onExecutionStateChange = async (event: WorkflowLifecycleNotification): Promise<void> => {
    const targetRoom = resolveNotificationRoom(event.conversationId);
    if (!targetRoom) return;
    let content: string;
    let trigger: boolean;
    if (event.kind === "waiting_human") {
      const q = event.question ? `：${event.question.slice(0, 200)}` : "";
      content = `【Workflow 等待人工确认】${event.workflowId}（执行 ${event.executionId}，节点 ${event.nodeId ?? "?"}）${q}\n请在收件箱 / Workflow 页面或卡片中处理。`;
      trigger = false;
    } else if (event.kind === "completed") {
      content = `【Workflow 完成】${event.workflowId}（执行 ${event.executionId}）已结束（exit=${event.exit ?? "success"}）。`;
      trigger = Boolean(event.triggeredBy?.startsWith("agent:"));
    } else if (event.kind === "cancelled") {
      content = `【Workflow 已取消】${event.workflowId}（执行 ${event.executionId}）。`;
      trigger = false;
    } else {
      content = `【Workflow 失败】${event.workflowId}（执行 ${event.executionId}）失败：${event.error ?? "unknown error"}`;
      trigger = Boolean(event.triggeredBy?.startsWith("agent:"));
    }
    await conversationService
      .postMessage({
        conversationId: targetRoom,
        senderMemberId: "system",
        trigger,
        content,
        authorization: "system",
      })
      .catch(() => {});
  };

  const workflowPort = sqliteWorkflowExecutionAdapter(db);
  const workflowNodeRunners = createNodeRunners({
    dataDir: config.dataDir,
    scriptsEnabled: config.workflowScriptsEnabled,
    denyReadDirs: config.workflowScriptDenyReadDirs,
    onLog: (executionId, data) =>
      workflowPort
        .appendExecutionEvent({ executionId, event: "script_log", data, ts: Date.now() })
        .catch(() => {}),
  });

  const workflowExecutionService = createWorkflowExecutionService({
    port: workflowPort,
    nodeRunners: workflowNodeRunners,
    idGen: ulid,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService,
    artifactService,
    resolveDefaultModel: async (agentId) => agentModelRef(await agentSvc.getById(agentId)),
    agentProjects: async (agentId) =>
      (await agentSvc.getById(agentId))?.config.runtime_config.projects ?? [],
    // ADR 0084 D5: create ONE shared Requirement for repo-aware executions so
    // every agent node in the pipeline shares ONE git worktree.
    ensureRequirementForExecution: ({ workflowId, workflowName, projectId, conversationId }) => {
      const opened = requirementSvc.create({
        title: `${workflowName ?? workflowId} (workflow)`,
        goal: `Shared requirement for workflow ${workflowId} execution.`,
        projectId,
        originConversationId: conversationId ?? null,
        createdByAgentId: null,
      });
      return opened.requirementId;
    },
    attachConversationRequirement: ({ conversationId, requirementId }) => {
      workspaceSvc.attachConversation({ conversationId, requirementId });
    },
    setRunRequirement: (runId, requirementId) => {
      agentRunPort.setRequirementId?.(runId, requirementId);
    },
    // ADR 0084 D7: capability pool worker routing (reusing recallWorkers).
    resolveCapabilityAgent: async ({ capability, repo }) => {
      const rows = await agentSvc.list();
      const load = new Map((await agentRunPort.agentLoad()).map((l) => [l.agentId, l]));
      const candidates = rows
        .filter((row) => {
          if (row.archivedAt !== null || !row.config.enabled) return false;
          if (row.config.role !== "worker") return false;
          if (repo && !row.config.runtime_config.projects.includes(repo)) return false;
          return true;
        })
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
      if (candidates.length === 0) return null;
      const res = await recall(
        { workers: async () => candidates },
        { sources: ["capability"], brief: { capability } },
      );
      return res.hits[0]?.meta?.agentId ?? candidates[0]?.id ?? null;
    },
    onExecutionStateChange,
  });

  const workflowTriggerScheduler = createWorkflowTriggerScheduler({
    workflowDir,
    schedule: (expr: string, fn: () => void) => {
      const h = Bun.cron(expr, fn);
      return { stop: () => h.stop() };
    },
    startExecution: (input: {
      workflowId: string;
      definition: WorkflowDefinition;
      input: Record<string, unknown>;
      triggeredBy?: string;
    }) => workflowExecutionService.startExecution(input),
    listExecutions: (workflowId: string) => workflowExecutionService.listExecutions(workflowId),
    onCircuitOpen: async ({ workflowId, consecutiveFailures, cron }) => {
      const targetRoom = resolveNotificationRoom(null);
      if (!targetRoom) return;
      await conversationService
        .postMessage({
          conversationId: targetRoom,
          senderMemberId: "system",
          trigger: false,
          content: `【Workflow 定时熔断】${workflowId}${cron ? `（cron: ${cron}）` : ""} 已连续失败 ${consecutiveFailures} 次，定时触发已自动暂停。修复后手动运行成功一次即可自动恢复。`,
          authorization: "system",
        })
        .catch(() => {});
    },
  });

  // One-time boot migration: move legacy plaintext `workflow.trigger.<id>` keys
  // to AES-sealed `workflow.trigger_token.<id>`.
  {
    const legacyRows = db
      .query("SELECT key FROM settings WHERE key LIKE 'workflow.trigger.%'")
      .all() as Array<{ key: string }>;
    for (const row of legacyRows) {
      if (row.key.startsWith("workflow.trigger_token.")) continue;
      const wfId = row.key.slice("workflow.trigger.".length);
      const raw = settingsSvc.get<string>(row.key);
      if (typeof raw === "string" && raw.length > 0) {
        settingsSvc.set(`workflow.trigger_token.${wfId}`, raw);
      }
      settingsSvc.delete(row.key);
    }
  }

  /** Semantic validation: check every explicit agentId exists and repo is attached. */
  const validateSemantics = async (def: WorkflowDefinition): Promise<string[]> => {
    const issues: string[] = [];
    for (const node of def.nodes) {
      if (node.type !== "agent") continue;
      if (node.agentId) {
        const agent = await agentSvc.getById(node.agentId).catch(() => null);
        if (!agent) {
          issues.push(`node "${node.id}": agent "${node.agentId}" does not exist`);
          continue;
        }
        if (node.repo && !agent.config.runtime_config.projects.includes(node.repo)) {
          issues.push(
            `node "${node.id}": agent "${node.agentId}" is not attached to project "${node.repo}"`,
          );
        }
      }
    }
    return issues;
  };

  /** ADR 0084 D3: sandboxed single-script test runner for frontend verification. */
  const testScript = async (input: {
    code: string;
    input: Record<string, unknown>;
    timeoutMs?: number;
  }) => {
    const t0 = Date.now();
    const res = await runInSandbox({
      code: input.code,
      input: input.input,
      timeoutMs: input.timeoutMs ?? 10_000,
      isolation: { noNetwork: true, denyReadDirs: config.workflowScriptDenyReadDirs },
    });
    return {
      ok: res.exitCode === 0,
      exitCode: res.exitCode,
      output: res.output ?? null,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - t0,
    };
  };

  /** Guard: workflow authoring/running/cancellation is Front Desk PA-only. */
  const assertFrontDesk = async (agentId: string, toolName: string): Promise<void> => {
    const agent = await agentSvc.getById(agentId).catch(() => null);
    if (agent?.config.role === "worker") {
      throw new Error(
        `${toolName} is restricted to the front-desk PA (workers cannot manage SOPs)`,
      );
    }
  };

  /** ADR 0084 D2/D4: PA workflow tool implementations wired into product-tools. */
  const workflowProductTools: NonNullable<ProductToolsServiceDeps["workflows"]> = {
    async list() {
      const ids = workflowStore.listIds();
      const allExecs = await workflowExecutionService.listExecutions();
      const runningByWf = new Map<string, number>();
      for (const ex of allExecs) {
        if (ex.status === "running" || ex.status === "waiting_human") {
          runningByWf.set(ex.workflowId, (runningByWf.get(ex.workflowId) ?? 0) + 1);
        }
      }
      return {
        workflows: ids.map((workflowId) => {
          const parsed = workflowStore.readParsed(workflowId);
          return {
            workflowId,
            valid: parsed !== null,
            name: parsed?.meta?.name ?? workflowId,
            description: parsed?.meta?.description ?? "",
            concurrencyPolicy: parsed ? resolveConcurrencyPolicy(parsed) : "per_requirement",
            triggers: parsed?.triggers ?? [],
            activeExecutions: runningByWf.get(workflowId) ?? 0,
            updatedAt: workflowStore.statMtime(workflowId),
          };
        }),
      };
    },

    async read(workflowId) {
      if (!WORKFLOW_ID_RE.test(workflowId)) {
        throw new Error(`invalid workflow id: ${workflowId}`);
      }
      const raw = workflowStore.readRaw(workflowId);
      if (raw === null) throw new Error(`workflow not found: ${workflowId}`);
      const executions = (await workflowExecutionService.listExecutions(workflowId)).slice(0, 5);
      return {
        workflowId,
        definition: JSON.parse(raw),
        recentExecutions: executions.map((e) => ({
          executionId: e.executionId,
          status: e.status,
          triggeredBy: e.triggeredBy,
          createdAt: e.createdAt,
          terminalAt: e.terminalAt,
          error: e.error,
        })),
        history: workflowStore.history(workflowId, 5),
      };
    },

    async save({ agentId, workflowId, definition, summary }) {
      await assertFrontDesk(agentId, "workflow_save");
      if (!WORKFLOW_ID_RE.test(workflowId)) {
        throw new Error(`invalid workflow id: ${workflowId}`);
      }
      const parsed = parseWorkflow(definition);
      const semanticIssues = await validateSemantics(parsed);
      if (semanticIssues.length > 0) {
        throw new Error(`workflow semantic errors: ${semanticIssues.join("; ")}`);
      }
      const prev = workflowStore.readParsed(workflowId);
      const risk = classifyWorkflowRisk(prev, parsed);
      // ADR 0084 D2: script code or enabled cron triggers require human
      // verification & approval via Proposal; pure declarative SOPs save directly.
      if (risk.requiresApproval) {
        const proposal = proposalSvc.propose("workflow_definition", workflowId, {
          definition: parsed,
          requiresApprovalFor: risk.reasons,
          scriptNodes: risk.scriptNodes,
          cronTriggers: risk.cronTriggers,
          proposedBy: agentId,
          ...(summary ? { summary } : {}),
        });
        return {
          status: "pending_approval",
          workflowId,
          proposalId: proposal.id,
          requiresApprovalFor: risk.reasons,
          message: `Workflow "${workflowId}" contains ${risk.reasons.join(" + ")} changes that require human verification and approval in Web before taking effect.`,
        };
      }
      const commit = workflowStore.write(workflowId, parsed, {
        author: `agent:${agentId}`,
        summary: summary ?? `${prev ? "update" : "create"} ${workflowId}`,
      });
      void workflowTriggerScheduler.sync();
      return {
        status: "saved",
        workflowId,
        commit,
      };
    },

    async delete({ agentId, workflowId, reason }) {
      await assertFrontDesk(agentId, "workflow_delete");
      if (!WORKFLOW_ID_RE.test(workflowId)) {
        throw new Error(`invalid workflow id: ${workflowId}`);
      }
      const active = (await workflowExecutionService.listExecutions(workflowId)).find(
        (e) => e.status === "running" || e.status === "waiting_human",
      );
      if (active) {
        throw new Error(
          `cannot delete workflow "${workflowId}" while execution ${active.executionId} is ${active.status}`,
        );
      }
      const removed = workflowStore.remove(workflowId, {
        author: `agent:${agentId}`,
        summary: reason ? `delete ${workflowId}: ${reason}` : `delete ${workflowId}`,
      });
      if (!removed) throw new Error(`workflow not found: ${workflowId}`);
      settingsSvc.delete(`workflow.trigger_token.${workflowId}`);
      void workflowTriggerScheduler.sync();
      return { deleted: true, workflowId };
    },

    async run({ agentId, conversationId, workflowId, input, requirementId, projectId }) {
      await assertFrontDesk(agentId, "workflow_run");
      if (!WORKFLOW_ID_RE.test(workflowId)) {
        throw new Error(`invalid workflow id: ${workflowId}`);
      }
      const parsed = workflowStore.readParsed(workflowId);
      if (!parsed) throw new Error(`workflow not found or invalid: ${workflowId}`);
      const convRow = convPort.getConversation(conversationId);
      const effectiveReqId =
        requirementId ?? workspaceSvc.currentRequirementOf(conversationId) ?? null;
      const effectiveProjectId = projectId ?? convRow?.projectId ?? null;
      const row = await workflowExecutionService.startExecution({
        workflowId,
        definition: parsed,
        input,
        triggeredBy: `agent:${agentId}`,
        conversationId,
        requirementId: effectiveReqId,
        projectId: effectiveProjectId,
      });
      return {
        executionId: row.executionId,
        workflowId: row.workflowId,
        status: row.status,
        requirementId: row.requirementId,
        projectId: row.projectId,
      };
    },

    async status({ executionId, workflowId }) {
      if (executionId) {
        const exec = await workflowExecutionService.getExecution(executionId);
        if (!exec) throw new Error(`execution not found: ${executionId}`);
        const nodeRuns = await workflowExecutionService.listNodeRuns(executionId);
        let pendingHuman = null;
        if (exec.status === "waiting_human") {
          const waiting = nodeRuns.find((n) => n.status === "waiting_human");
          if (waiting) {
            pendingHuman = await workflowExecutionService.getPendingHuman(
              executionId,
              waiting.nodeId,
            );
          }
        }
        return {
          execution: {
            executionId: exec.executionId,
            workflowId: exec.workflowId,
            status: exec.status,
            exit: exec.exit,
            error: exec.error,
            requirementId: exec.requirementId,
            projectId: exec.projectId,
            createdAt: exec.createdAt,
            terminalAt: exec.terminalAt,
          },
          nodeRuns: nodeRuns.map((n) => ({
            nodeId: n.nodeId,
            status: n.status,
            runId: n.runId,
            output: n.output,
            error: n.error,
          })),
          pendingHuman,
        };
      }
      const list = (await workflowExecutionService.listExecutions(workflowId)).slice(0, 10);
      return {
        executions: list.map((e) => ({
          executionId: e.executionId,
          workflowId: e.workflowId,
          status: e.status,
          triggeredBy: e.triggeredBy,
          createdAt: e.createdAt,
          terminalAt: e.terminalAt,
          error: e.error,
        })),
      };
    },

    async cancel({ agentId, executionId }) {
      await assertFrontDesk(agentId, "workflow_cancel");
      const row = await workflowExecutionService.cancelExecution(executionId);
      if (!row) throw new Error(`execution not found: ${executionId}`);
      return { executionId: row.executionId, status: row.status };
    },
  };

  /** ADR 0084 D2: adopt a `workflow_definition` proposal on the backend. */
  const saveWorkflowDefinition = async (workflowId: string, definition: unknown): Promise<void> => {
    if (!WORKFLOW_ID_RE.test(workflowId)) {
      throw new Error(`invalid workflow id: ${workflowId}`);
    }
    const parsed = parseWorkflow(definition);
    const semanticIssues = await validateSemantics(parsed);
    if (semanticIssues.length > 0) {
      throw new Error(`workflow semantic errors: ${semanticIssues.join("; ")}`);
    }
    workflowStore.write(workflowId, parsed, {
      author: "user (adopted proposal)",
      summary: `adopt proposal for ${workflowId}`,
    });
    void workflowTriggerScheduler.sync();
  };

  const workflowApp = workflowRoutes({
    workflowExecutionService,
    store: workflowStore,
    validateSemantics,
    testScript,
    loadWorkflow: async (ref) => {
      const file = join(workflowDir, ref.path);
      if (!resolve(file).startsWith(resolve(workflowDir))) {
        throw new Error(`workflow path escapes workflows dir: ${ref.path}`);
      }
      return await Bun.file(file).text();
    },
    workflowDir,
    scriptsEnabled: config.workflowScriptsEnabled,
    getTriggerToken: async (workflowId) =>
      settingsSvc.get<string>(`workflow.trigger_token.${workflowId}`),
    setTriggerToken: async (workflowId, token) => {
      settingsSvc.set(`workflow.trigger_token.${workflowId}`, token);
    },
    deleteTriggerToken: async (workflowId) => {
      settingsSvc.delete(`workflow.trigger_token.${workflowId}`);
    },
    labelResolver: entityLabels,
    resyncTriggers: () => workflowTriggerScheduler.sync(),
  });

  return {
    workflowPort,
    workflowStore,
    workflowExecutionService,
    workflowTriggerScheduler,
    workflowProductTools,
    saveWorkflowDefinition,
    workflowApp,
  };
}
