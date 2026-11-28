import type { Database } from "bun:sqlite";
import { extractText, type Message, serializeMessageRevision } from "@chengchenccc/message";
import type { BackendConfig } from "../config.js";
import type { AgentIdentityStore } from "../features/agent/agent-identity.js";
import { FRONT_DESK_DISABLED_TOOLS } from "../features/agent/front-desk-tools.js";
import type { AgentService } from "../features/agent/index.js";
import { FRONT_DESK_DISCIPLINE } from "../features/agent/prompt-front-desk.js";
import {
  type McpServerEntry,
  writeMcpConfig,
  writeProductToolsManifest,
} from "../features/agent/workspace-bridge.js";
import type { AgentContextPort, AgentContextService } from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import { AcpBackend } from "../features/agent-run/acp/acp-backend.js";
import { AcpModelCatalog } from "../features/agent-run/acp/model-catalog.js";
import type { BudgetGate } from "../features/agent-run/budget-gate.js";
import { deliveryNoteOf, producedByEvent } from "../features/agent-run/delivery-gate.js";
import { pendingActionId } from "../features/agent-run/domain.js";
import { finalAnswerMessage } from "../features/agent-run/execution-input.js";
import {
  type AgentRunExecutionService,
  type AgentRunPort,
  type AgentRunService,
  createAgentRunExecutionService,
  createAgentRunService,
  type RunWorkspace,
} from "../features/agent-run/index.js";
import {
  deriveInterruptedJobs,
  type JobStateEvent,
  renderInterruptedJobs,
} from "../features/agent-run/interrupted-jobs.js";
import { createNotifyDispatcher } from "../features/agent-run/notify-dispatcher.js";
import type { BackendRegistry } from "../features/agent-run/protocol/index.js";
import type { RecallHit } from "../features/agent-run/recall.js";
import { requestOwnerOf } from "../features/agent-run/request-owner.js";
import {
  isIrreversibleRequest,
  isStatusQuestion,
} from "../features/agent-run/routing-observations.js";
import { endsWithQuestion, lastParagraph } from "../features/agent-run/unasked-question.js";
import type { createAhpChatWriter } from "../features/ahp/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import {
  type ConversationPort,
  deriveConversationTitle,
  firstUserText,
} from "../features/conversation/index.js";
import type { ConversationService } from "../features/conversation/service.js";
import type { McpRuntimeStatusStore } from "../features/mcp/index.js";
import {
  createProductToolsDispatch,
  frameResultInput,
  type ProductToolsService,
} from "../features/product-tools/index.js";
import type { RunTokenRegistry } from "../features/product-tools/run-token-registry.js";
import type { ProjectService } from "../features/project/index.js";
import type { WorkspaceLockRegistry } from "../features/project/workspace-lock.js";
import type { createMemoryRecall } from "../features/recall/memory-recall.js";
import type { RequirementService } from "../features/requirement/index.js";
import type { RuntimeOpsStore } from "../features/runtime-ops/index.js";
import type { SettingsService } from "../features/settings/index.js";
import {
  BUILTIN_PACK_ID,
  installPath,
  resolveBuiltinSkillsDirForRole,
  type SkillPackPort,
} from "../features/skill-pack/index.js";
import type { createWorkspaceService } from "../features/workspace/service.js";
import { startAllowlistProxy } from "../infra/allowlist-proxy.js";
import type { resolveOmaAcpArgv } from "../infra/oma-command.js";
import { sseUrlEndpoint } from "../infra/sse-url.js";

/** Frozen system prompt from the Agent's editable identity files:
 *  SOUL.md as the identity, USER.md as the user context. */
export function buildAgentSystemPrompt(
  soul: string | null,
  user: string | null,
  /** ADR 0057: only agents that face humans get the routing discipline; a
   *  worker has nobody to route for. Absent role = legacy front. */
  opts?: { role?: "front" | "worker" | null },
): string | undefined {
  const parts: string[] = [];
  if (soul) parts.push(soul);
  if (user) parts.push(`User context:\n${user}`);
  if (opts?.role !== "worker") parts.push(FRONT_DESK_DISCIPLINE);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Sync agent role lookup against SQLite (used inside transactions and request routing). */
export function createRoleOfAgent(db: Database): (agentId: string) => "worker" | "front" | null {
  return (agentId: string) => {
    const row = db.query("SELECT config FROM agents WHERE id = ?").get(agentId) as {
      config: string;
    } | null;
    if (row === null) return null;
    try {
      const cfg = JSON.parse(row.config) as { role?: "worker" | "front" };
      return cfg.role === "worker" ? "worker" : "front";
    } catch {
      return null;
    }
  };
}

export interface AgentRunServiceWiringDeps {
  config: BackendConfig;
  agentSvc: AgentService;
  agentRunPort: AgentRunPort;
  contextSvc: AgentContextService;
  ledgerResolver: LedgerMessageResolver;
  identityStore: AgentIdentityStore;
  skillPackPort: SkillPackPort;
  convPort: ConversationPort;
  projectSvc: ProjectService;
  opsStore: RuntimeOpsStore;
  ulid: () => string;
}

/** Wire AgentRunService with frozen run config resolution (identity, role-scoped
 *  skills, interrupted-jobs summary, room project hint, front-desk tool policy). */
export function wireAgentRunService(deps: AgentRunServiceWiringDeps): AgentRunService {
  const {
    config,
    agentSvc,
    agentRunPort,
    contextSvc,
    ledgerResolver,
    identityStore,
    skillPackPort,
    convPort,
    projectSvc,
    opsStore,
    ulid,
  } = deps;

  return createAgentRunService({
    port: agentRunPort,
    contextService: contextSvc,
    idGen: { ulid },
    ledgerResolver,
    // Default frozen Run config: the target Agent's identity (SOUL.md +
    // USER.md) and its assigned READY skill packs.
    resolveRunConfig: async ({ conversationId, agentId }) => {
      if (!agentId) return {};
      const identity = await identityStore.getIdentity(agentId);
      const agentRow = await agentSvc.getById(agentId).catch(() => null);
      const systemPrompt = buildAgentSystemPrompt(identity.soul, identity.user, {
        role: agentRow?.config.role ?? null,
      });
      const agentRole = agentRow?.config.role === "worker" ? "worker" : "front";
      const builtinRoleDir = resolveBuiltinSkillsDirForRole(
        config.dataDir,
        config.builtinSkillsDir,
        agentRole,
      );
      const packs = await skillPackPort.listForAgent(agentId);
      const packRoots = packs
        .filter((p) => p.status === "ready")
        .map((p) =>
          p.id === BUILTIN_PACK_ID ? builtinRoleDir : installPath(config.dataDir, p.id),
        );
      // Role-scoped builtin skills are ALWAYS available - assigned packs add on top.
      const skillRoots = [builtinRoleDir, ...packRoots.filter((r) => r !== builtinRoleDir)];
      // ADR 0063 D2: what the LAST turn started and never finished. Derived
      // from telemetry (a started row with no end), never replayed - the
      // model decides whether re-running is safe.
      let interruptedBlock = "";
      try {
        const recent = await agentRunPort.listRecentRunsForConversations(
          [conversationId],
          7 * 24 * 60 * 60 * 1000,
        );
        const previous = recent
          .filter(
            (run) =>
              run.agentId === agentId &&
              run.terminalAt !== null &&
              (run.status === "completed" ||
                run.status === "failed" ||
                run.status === "aborted" ||
                run.status === "timeout"),
          )
          .sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0))[0];
        if (previous) {
          const events = opsStore.listRunEvents(previous.runId, 500);
          interruptedBlock = renderInterruptedJobs(
            deriveInterruptedJobs(events as unknown as JobStateEvent[]),
          );
        }
      } catch {
        /* a missing history never blocks a run */
      }
      const basePrompt = systemPrompt ?? "";
      const withInterrupted = interruptedBlock
        ? basePrompt
          ? `${basePrompt}\n\n${interruptedBlock}`
          : interruptedBlock
        : basePrompt;
      // ADR 0076 H4, the fourth read point: the room's project is told to the
      // front desk itself so it stops asking "which project?" in a project room.
      const roomProjectId = convPort.getConversation(conversationId)?.projectId ?? null;
      const roomProject = roomProjectId === null ? null : projectSvc.getById(roomProjectId);
      const roomLine =
        roomProject === null
          ? ""
          : `\n\nThis room is about the project "${roomProject.name}". A request here is about that project unless the person says otherwise — do not ask which project.`;
      const withRoom = `${withInterrupted}${roomLine}`.trim();
      const result: {
        systemPrompt?: string;
        skillRoots?: readonly string[];
        permissionMode?: string;
        toolPolicy?: { deny: string[]; allow: string[]; denyCommands?: string[] };
      } = {};
      if (withRoom) result.systemPrompt = withRoom;
      if (skillRoots.length > 0) result.skillRoots = skillRoots;
      const agent = agentRow;
      if (agent) result.permissionMode = agent.config.runtime_config.permission_mode;
      if (agent) {
        const rc = agent.config.runtime_config;
        // ADR 0072/0074: front desk routes and does not edit code or shell out.
        // Workers keep every tool.
        const frontDeskTools = agent.config.role === "worker" ? [] : [...FRONT_DESK_DISABLED_TOOLS];
        if (
          rc.deny_write_paths.length > 0 ||
          rc.allow_write_paths.length > 0 ||
          rc.deny_commands.length > 0 ||
          frontDeskTools.length > 0
        ) {
          result.toolPolicy = {
            deny: [...rc.deny_write_paths],
            allow: [...rc.allow_write_paths],
            denyCommands: [...rc.deny_commands],
            ...(frontDeskTools.length > 0 ? { disabledTools: frontDeskTools } : {}),
          };
        }
      }
      return result;
    },
    resolveAgentEnabled: async ({ agentId }) => {
      if (!agentId) return true;
      const agent = await agentSvc.getById(agentId).catch(() => null);
      return agent?.config.enabled ?? true;
    },
  });
}

export interface RunCoordinationDeps {
  agentSvc: AgentService;
  agentRunPort: AgentRunPort;
  contextPort: AgentContextPort;
  convPort: ConversationPort;
  convSvc: ConversationService;
  roleOfAgent: (agentId: string) => "worker" | "front" | null;
  injectSteer: (
    branchId: string,
    input: { inputId: string; message: Message },
    opts?: { keepIfIdle?: boolean },
  ) => Promise<void>;
}

/** Shared cross-run coordination closures: upward dispatcher notifications
 *  (ADR 0059 D5) and parked-request owner surfacing (ADR 0075). */
export function wireRunCoordination(deps: RunCoordinationDeps) {
  const { agentSvc, agentRunPort, contextPort, convPort, convSvc, roleOfAgent, injectSteer } = deps;

  const notifyDispatcher = createNotifyDispatcher({
    getRun: (runId) => agentRunPort.getRun(runId),
    getActiveRun: (branchId) => agentRunPort.getActiveRun(branchId),
    // ADR 0060 D3: at the chain-depth limit the notice goes to the agent the
    // human talks to, never to the worker chain that hit the limit.
    getFrontDeskAgent: async (conversationId) =>
      convPort.getConversation(conversationId)?.agentId ?? null,
    enqueueSteer: async (input) => {
      const steerBranch = await contextPort.getBranch(input.branchId).catch(() => null);
      const res = await agentRunPort.enqueueAndAcquire({
        conversationId: input.conversationId,
        agentId: input.agentId,
        branchId: input.branchId,
        mode: "steer",
        message: input.message,
        inputIdempotencyKey: input.idempotencyKey,
        runIdempotencyKey: input.idempotencyKey,
        deliveryIdempotencyKey: input.idempotencyKey,
        defaultModel: input.defaultModel,
        configRevision: input.configRevision,
        expectedRevision: steerBranch?.revision ?? input.configRevision,
        authorization: input.authorization,
        parentRunId: input.parentRunId,
      });
      return { inputId: res.inputId, queued: res.queued, acquired: res.acquired };
    },
    injectSteer,
    postMessage: (input) =>
      convSvc.postMessage({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        trigger: input.trigger,
        content: input.content,
        authorization: input.authorization,
        parentRunId: input.parentRunId,
      }),
    // ADR 0060 D6: the mark is what recovery sweeps on; without it a lost
    // notice is invisible forever.
    markNotified: (runId) => agentRunPort.markResultNotified(runId),
  });

  const onRequestCreated = (input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }): void => {
    void surfaceParkedRequest(
      { agentSvc, agentRunPort, convPort, convSvc, roleOfAgent },
      input,
    ).catch(async (err: unknown) => {
      console.error(
        `[bootstrap] request notice failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // The machine route (the owner agent) could not be told, so it will
      // never answer: hand the question to the person instead of leaving an
      // orphan in the inbox that reads as "the agent is on it".
      await agentRunPort
        .escalateActionToUser?.(pendingActionId(input.runId, input.callId))
        .catch(() => undefined);
    });
  };

  return { notifyDispatcher, onRequestCreated };
}

/** ADR 0075: route a parked request (ask or approval) to its owner — either the
 *  dispatching agent in its room, or the parent room's front desk when a child
 *  room parks on a human-owned decision. */
export async function surfaceParkedRequest(
  deps: Pick<
    RunCoordinationDeps,
    "agentSvc" | "agentRunPort" | "convPort" | "convSvc" | "roleOfAgent"
  >,
  input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const { agentSvc, agentRunPort, convPort, convSvc, roleOfAgent } = deps;
  const run = await agentRunPort.getRun(input.runId).catch(() => null);
  if (run === null) return;
  const room = convPort.getConversation(run.conversationId);
  if (!room) return;
  const owner = requestOwnerOf({
    authorization: run.authorization ?? null,
    roleOf: roleOfAgent,
  });
  const worker =
    run.agentId === null ? null : await agentSvc.getById(run.agentId).catch(() => null);
  const workerName = worker?.config.name ?? run.agentId ?? "worker";
  const askQuestions =
    input.kind === "ask"
      ? ((input.payload.questions as Array<{ question?: string }> | undefined) ?? [])
          .map((q) => String(q.question ?? "").trim())
          .filter(Boolean)
      : [];
  const detail =
    input.kind === "approval"
      ? `审批：${String(input.payload.toolName ?? "动作")} — ${String(input.payload.reason ?? "").slice(0, 200)}`
      : `提问：${askQuestions.join("；").slice(0, 400)}`;

  if (owner.agentId === null) {
    // Human-owned. A root room already reaches the inbox (and the Lark card
    // renders the pending action). A child room does not: wake the parent
    // room's front desk so it escalates with a structured ask card.
    const parentId = room.parentConversationId;
    if (!parentId) return;
    const frontDesk = convPort.getConversation(parentId)?.agentId ?? null;
    if (frontDesk === null) return;
    const escalationRule =
      input.kind === "approval"
        ? "用 ask_question 在本房间升级给人：写清谁在问、在做什么、要执行什么、为什么必须由人决定、影响范围，并给出允许/拒绝选项。"
        : "用 ask_question 在本房间升级给人：写清谁在问、在做什么，把全部待决问题和选项一次性转交给人类决定。";
    await convSvc.postMessage({
      conversationId: parentId,
      senderMemberId: run.agentId ?? "system",
      content: [
        `【需要人类决定】${workerName} 在子会话「${room.title ?? "未命名"}」停下了：${detail}`,
        escalationRule,
      ].join("\n"),
    });
    return;
  }

  const target = room.parentConversationId ?? room.conversationId;
  await convSvc.postMessage({
    conversationId: target,
    senderMemberId: run.agentId ?? "system",
    content: [
      `【请求】${workerName} 需要你决定：${detail}`,
      `用 answer_worker_request(run_id="${run.runId}", call_id="${input.callId}", evidence=[...]) 回答；`,
      "答不了（不可逆操作 / 超出授权 / 验收 / 无证据）就升级给人。",
    ].join("\n"),
  });
}

/** Read the dispatcher's most recent non-empty `todo_snapshot` as markdown lines. */
export function readDispatcherPlan(db: Database, dispatcherConversationId: string | null): string {
  if (dispatcherConversationId === null) return "";
  const row = db
    .query(
      `SELECT todo_snapshot FROM agent_run
        WHERE conversation_id = ? AND todo_snapshot IS NOT NULL AND todo_snapshot <> ''
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(dispatcherConversationId) as { todo_snapshot: string } | null;
  if (row === null) return "";
  try {
    const parsed: unknown = JSON.parse(row.todo_snapshot);
    if (!Array.isArray(parsed)) return "";
    const lines: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const text = "text" in item && typeof item.text === "string" ? item.text : "";
      const status = "status" in item && typeof item.status === "string" ? item.status : "";
      if (text !== "") lines.push(`- [${status || "pending"}] ${text}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Extract `artifacts://` URLs uploaded by a run from the product_tool_call ledger. */
export function readRunArtifactUrls(db: Database, runId: string): string[] {
  const rows = db
    .query(
      "SELECT result FROM product_tool_call WHERE run_id = ? AND tool_name = 'artifact_upload'",
    )
    .all(runId) as Array<{ result: string | null }>;
  const urls: string[] = [];
  for (const row of rows) {
    if (row.result === null) continue;
    try {
      const parsed: unknown = JSON.parse(row.result);
      if (typeof parsed === "object" && parsed !== null && "url" in parsed) {
        const url = parsed.url;
        if (typeof url === "string" && url.startsWith("artifacts://")) urls.push(url);
      }
    } catch {
      /* a malformed row is skipped, never fatal */
    }
  }
  return urls;
}

export interface CommittedTurnObservationDeps {
  db: Database;
  agentSvc: Pick<AgentService, "getById">;
  agentRunPort: Pick<AgentRunPort, "listPendingActions" | "listDecidedActions">;
  agentRunService: Pick<AgentRunService, "listInputs">;
  opsStore: Pick<RuntimeOpsStore, "appendRunEvent">;
}

/** ADR 0066 + ADR 0075 post-commit telemetry observations (best-effort, never throws).
 *  Shares agent role, pending actions, and dispatch ledger lookup across all checks. */
export async function observeCommittedTurn(
  deps: CommittedTurnObservationDeps,
  input: {
    runId: string;
    agentId: string;
    branchId: string;
    output: Message;
  },
): Promise<void> {
  const { db, agentSvc, agentRunPort, agentRunService, opsStore } = deps;
  const { runId, agentId, branchId, output } = input;
  try {
    const answer = extractText(output);
    const pending = await agentRunPort.listPendingActions(runId).catch(() => []);

    // Observation 1 (ADR 0066): ended with a question without opening an ask.
    if (endsWithQuestion(answer) && !pending.some((action) => action.kind === "ask")) {
      opsStore.appendRunEvent(runId, "unasked_question", {
        tail: lastParagraph(answer).slice(0, 200),
      });
    }

    // Observations 2 & 3 (ADR 0075) apply to front-desk turns only.
    const role = (await agentSvc.getById(agentId).catch(() => null))?.config.role;
    if (role === "worker") return;

    const dispatchedRows = db
      .query("SELECT 1 FROM product_tool_call WHERE run_id = ? AND tool_name = 'dispatch' LIMIT 1")
      .all(runId);
    const dispatched = dispatchedRows.length > 0;

    // Observation 2: irreversible request unasked / status question dispatched.
    const inputs = await agentRunService.listInputs(branchId).catch(() => []);
    const mine = inputs.find((i) => i.runId === runId);
    const requestText = typeof mine?.message?.text === "string" ? mine.message.text : "";
    if (requestText !== "") {
      const decided = await agentRunPort.listDecidedActions(runId).catch(() => []);
      const asked = pending.some((a) => a.kind === "ask") || decided.some((d) => d.kind === "ask");
      if (isIrreversibleRequest(requestText) && !asked && !dispatched) {
        opsStore.appendRunEvent(runId, "irreversible_unasked", {
          head: requestText.slice(0, 160),
        });
      }
      if (isStatusQuestion(requestText) && dispatched) {
        opsStore.appendRunEvent(runId, "status_question_dispatched", {
          head: requestText.slice(0, 160),
        });
      }
    }

    // Observation 3: front desk produced a long-form answer with no dispatch.
    if (answer.length >= 800 && !dispatched) {
      opsStore.appendRunEvent(runId, "unrouted_work", {
        chars: answer.length,
        head: answer.slice(0, 160),
      });
    }
  } catch {
    /* an observation must never disturb the turn */
  }
}

export interface AgentRunExecutionWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  settingsSvc: SettingsService;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  agentRunPort: AgentRunPort;
  agentRunService: AgentRunService;
  contextPort: AgentContextPort;
  convPort: ConversationPort;
  ledgerResolver: LedgerMessageResolver;
  artifactService: ArtifactService;
  requirementSvc: RequirementService;
  workspaceSvc: ReturnType<typeof createWorkspaceService>;
  workspaceForRun: (input: {
    conversationId: string;
    agentId: string | null;
    runId?: string;
  }) => Promise<RunWorkspace>;
  workspaceLocks: WorkspaceLockRegistry;
  budgetGate: BudgetGate;
  memoryRecall: ReturnType<typeof createMemoryRecall>;
  chatWriter: ReturnType<typeof createAhpChatWriter>;
  mcpRuntimeStatus: McpRuntimeStatusStore;
  prepareMcpBridge: (agentId: string) => Promise<{
    servers: McpServerEntry[];
    env: Record<string, string>;
    expandableVars: string[];
  }>;
  productToolsManifest: () => readonly unknown[];
  enabledMcpServers: ReadonlySet<string>;
  omaAcpArgv: ReturnType<typeof resolveOmaAcpArgv>;
  productTools: ProductToolsService;
  productToolsTokenRegistry: RunTokenRegistry;
  roleOfAgent: (agentId: string) => "worker" | "front" | null;
  recallByRun: Map<string, readonly RecallHit[]>;
  notifyDispatcher: ReturnType<typeof createNotifyDispatcher>;
  onRequestCreated: (input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }) => void;
}

/** Wire ACP backend, cooperative sandbox allowlist proxy, run lifecycle
 *  callbacks (title, observations, delivery gate, report artifact, upward
 *  notifications), and AgentRunExecutionService. */
export async function wireAgentRunExecution(deps: AgentRunExecutionWiringDeps) {
  const {
    config,
    db,
    ulid,
    settingsSvc,
    opsStore,
    agentSvc,
    agentRunPort,
    agentRunService,
    contextPort,
    convPort,
    ledgerResolver,
    artifactService,
    requirementSvc,
    workspaceSvc,
    workspaceForRun,
    workspaceLocks,
    budgetGate,
    memoryRecall,
    chatWriter,
    mcpRuntimeStatus,
    prepareMcpBridge,
    productToolsManifest,
    enabledMcpServers,
    omaAcpArgv,
    productTools,
    productToolsTokenRegistry,
    roleOfAgent,
    recallByRun,
    notifyDispatcher,
    onRequestCreated,
  } = deps;

  const agentNameOf = async (agentId: string | null): Promise<string> => {
    if (agentId === null) return "unknown member";
    const agent = await agentSvc.getById(agentId).catch(() => null);
    return agent?.config.name ?? agentId;
  };

  // T3-2: failed/aborted/timeout runs persist an assistant error message so
  // the failure survives refresh (transient bubbles die with the page).
  const onRunFailed = (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }): void => {
    void (async () => {
      const msg = {
        messageId: `run:${input.runId}:error`,
        state: "error" as const,
        role: "assistant" as const,
        text: input.error,
        visibility: "conversation" as const,
        conversationId: input.conversationId,
        updatedAt: Date.now(),
        error: { message: input.error },
      };
      convPort.appendLedgerEntry({
        conversationId: input.conversationId,
        kind: "message",
        content: serializeMessageRevision(msg),
        ts: Date.now(),
      });
      await chatWriter.foldCommittedTurn(input.runId, 0);
      // ADR 0059 D5: a dispatched worker's failure is the dispatcher's business too.
      const run = await agentRunPort.getRun(input.runId);
      if (run?.parentRunId && run.authorization?.startsWith("dispatch:") === true) {
        await notifyDispatcher({
          fromAgentId: run.agentId,
          conversationId: run.conversationId,
          runId: input.runId,
          text: frameResultInput(await agentNameOf(run.agentId), "failed", input.error),
          wake: true,
        });
      }
    })().catch((err) => console.error(`[bootstrap] onRunFailed failed for ${input.runId}:`, err));
  };

  const onRunCommitted = (
    runId: string,
    output: Message | undefined,
    _committedSeq: readonly number[],
  ): void => {
    void (async () => {
      const run = await agentRunPort.getRun(runId);
      if (!run || !output) return;
      // Product-owned title (see conversation/title.ts).
      const convRow = convPort.getConversation(run.conversationId);
      if (convRow && !convRow.title && run.terminalResult?.status === "completed") {
        const title = deriveConversationTitle(
          firstUserText(convPort.getLedgerEntries(run.conversationId)),
        );
        if (title) convPort.setConversationTitle(run.conversationId, title);
      }
      await chatWriter.foldCommittedTurn(
        runId,
        Math.max(0, (run.terminalAt ?? Date.now()) - run.createdAt),
      );
      // Best-effort ADR 0066 + ADR 0075 telemetry observations (non-blocking).
      void observeCommittedTurn(
        { db, agentSvc, agentRunPort, agentRunService, opsStore },
        { runId, agentId: run.agentId, branchId: run.branchId, output },
      );
      // ADR 0059 D5 + ADR 0070 + ADR 0076 H1: materialize deliverable report and
      // notify the dispatcher in its parent room.
      if (run.parentRunId && run.authorization?.startsWith("dispatch:") === true) {
        const finalText = extractText(output);
        let artifacts = readRunArtifactUrls(db, runId);
        if (artifacts.length === 0 && finalText.trim() !== "") {
          try {
            const uploaded = await artifactService.upload({
              folder: "reports",
              filename: `${runId}.md`,
              content: finalText,
              encoding: "utf8",
              source: { runId, conversationId: run.conversationId, agentId: run.agentId },
            });
            artifacts = [uploaded.url];
          } catch (err) {
            console.error(
              `[bootstrap] report artifact for ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const parentConversationId =
          convPort.getConversation(run.conversationId)?.parentConversationId ?? null;
        await notifyDispatcher({
          fromAgentId: run.agentId,
          conversationId: parentConversationId ?? run.conversationId,
          runId,
          text: frameResultInput(
            await agentNameOf(run.agentId),
            "completed",
            finalText,
            artifacts,
            readDispatcherPlan(db, parentConversationId),
          ),
          wake: true,
        });
      }
    })().catch((err) => console.error(`[bootstrap] onRunCommitted failed for ${runId}:`, err));
  };

  // Cooperative HTTP(S)_PROXY allowlist when configured.
  const configuredAllowlist = settingsSvc.get("sandbox.networkAllowlist");
  const allowlistHosts = Array.isArray(configuredAllowlist)
    ? configuredAllowlist.filter(
        (host): host is string => typeof host === "string" && host.trim() !== "",
      )
    : [];
  const sandboxProxy = allowlistHosts.length > 0 ? await startAllowlistProxy(allowlistHosts) : null;

  const acpBackend = new AcpBackend({
    onSessionBound: (runId, nativeRef) => agentRunPort.setRunNativeSessionRef(runId, nativeRef),
    env: {
      ...(config.omaPermissionClassifierModel
        ? { OMA_PERMISSION_CLASSIFIER_MODEL: config.omaPermissionClassifierModel }
        : {}),
      ...(config.browserLocalNetwork ? { OMA_BROWSER_LOCAL_NETWORK: "1" } : {}),
      ...(sandboxProxy
        ? {
            HTTP_PROXY: sandboxProxy.url,
            HTTPS_PROXY: sandboxProxy.url,
            http_proxy: sandboxProxy.url,
            https_proxy: sandboxProxy.url,
            NO_PROXY: "127.0.0.1,localhost,::1",
            no_proxy: "127.0.0.1,localhost,::1",
          }
        : {}),
    },
    commands: { oma: omaAcpArgv },
    // MCP-over-ACP (ADR 0039 appendix two)
    ...(enabledMcpServers.has("product-tools")
      ? {
          acpMcpProvider: {
            name: "product-tools",
            serverId: "product-tools",
            ...createProductToolsDispatch({ service: productTools, roleOf: roleOfAgent }),
          },
        }
      : {}),
  });

  const acpCatalog = new AcpModelCatalog();
  const backends: BackendRegistry = {
    acp: { backend: acpBackend, catalog: acpCatalog },
  };

  const agentRunExecution: AgentRunExecutionService = createAgentRunExecutionService({
    budgetGate,
    onRequestCreated,
    workspaceLocks,
    productToolsTokenRegistry,
    runTimeoutMs: config.runTimeoutMs,
    runPort: agentRunPort,
    contextPort,
    conversationSearch: (keyword, limit, scope) => convPort.searchLedger(keyword, limit, scope),
    onRecall: (runId, hits) => {
      if (recallByRun.size >= 200) {
        const oldest = recallByRun.keys().next().value;
        if (oldest !== undefined) recallByRun.delete(oldest);
      }
      recallByRun.set(runId, hits);
    },
    ledgerResolver,
    backends,
    idGen: { ulid },
    resolveWorkspace: ({ conversationId, agentId, runId }) =>
      workspaceForRun({ conversationId, agentId, ...(runId !== undefined ? { runId } : {}) }),
    searchMemory: (input) => memoryRecall.search(input),
    searchRequirements: (query, limit) => {
      const needle = query.toLowerCase();
      return requirementSvc
        .list(false)
        .filter((r) => `${r.title}\n${r.goal}`.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((r) => ({
          requirementId: r.requirementId,
          title: r.title,
          goal: r.goal,
          status: r.status,
          at: r.updatedAt,
        }));
    },
    onHumanInputResolved: (input) => {
      void chatWriter
        .announceHumanInput(input)
        .catch((err) =>
          console.error(`[bootstrap] human input announcement failed for ${input.runId}:`, err),
        );
    },
    onLiveEvent: chatWriter.onLiveEvent,
    productToolsEntrypoint: config.productToolsMcpUrl
      ? `sse:${sseUrlEndpoint(config.productToolsMcpUrl)}`
      : "stdio:/nonexistent",
    rewriteWorkspaceBridge: async (agentId, root) => {
      const prepared = await prepareMcpBridge(agentId);
      writeMcpConfig(root, prepared.servers);
      writeProductToolsManifest(root, productToolsManifest());
      return { env: prepared.env, expandableVars: prepared.expandableVars };
    },
    onRunCommitted,
    // ADR 0072/0076 delivery gate: append verification status to front-desk output.
    deliveryNote: async (run) => {
      if (!run.agentId) return undefined;
      const agent = await agentSvc.getById(run.agentId).catch(() => null);
      if (agent?.config.role === "worker") return undefined;
      const WINDOW_MS = 6 * 60 * 60_000;
      const requirementId = workspaceSvc.currentRequirementOf(run.conversationId);
      const byRequirement =
        requirementId === null
          ? null
          : await agentRunPort.listRunsForRequirement?.(requirementId, WINDOW_MS).catch(() => null);
      const recent =
        byRequirement ??
        (await agentRunPort
          .listDispatchedRuns?.(run.conversationId, WINDOW_MS)
          .catch(() => null)) ??
        (await agentRunPort
          .listRecentRunsForConversations([run.conversationId], WINDOW_MS)
          .catch(() => []));
      const note = deliveryNoteOf({
        selfAgentId: run.agentId,
        runs: recent.map((r) => ({
          runId: r.runId,
          agentId: r.agentId,
          parentRunId: r.parentRunId,
          createdAt: r.createdAt,
          terminalAt: r.terminalAt,
          status: r.terminalResult?.status ?? r.status,
        })),
        produced: (runId) =>
          opsStore.listRunEvents(runId, 2000).some((e) => producedByEvent(JSON.stringify(e))),
        deliveryOf: (runId) => {
          const event = opsStore
            .listRunEvents(runId, 2000)
            .find((e) => e.type === "project_delivered");
          if (event === undefined) return undefined;
          const data = event.data as { branch?: unknown; compareUrl?: unknown };
          if (typeof data.branch !== "string") return undefined;
          return {
            branch: data.branch,
            compareUrl: typeof data.compareUrl === "string" ? data.compareUrl : null,
          };
        },
      });
      console.log(
        `[delivery-gate] run=${run.runId.slice(0, 12)} dispatched=${recent.length} → ${note ?? "verified"}`,
      );
      return note;
    },
    // ADR 0060 D6: recovery saw a terminal dispatched run with no confirmed notice.
    onRunResultUndelivered: (run) => {
      void (async () => {
        const outcome = run.terminalResult;
        const text =
          outcome?.status === "completed"
            ? extractText(finalAnswerMessage(outcome.messages) ?? {})
            : (outcome?.error ?? "（没有记录失败原因）");
        const parentConversationId =
          convPort.getConversation(run.conversationId)?.parentConversationId ?? null;
        await notifyDispatcher({
          fromAgentId: run.agentId,
          conversationId: parentConversationId ?? run.conversationId,
          runId: run.runId,
          text: frameResultInput(
            await agentNameOf(run.agentId),
            outcome?.status === "completed" ? "completed" : (outcome?.status ?? "failed"),
            text,
            readRunArtifactUrls(db, run.runId),
            readDispatcherPlan(db, parentConversationId),
          ),
          wake: true,
        });
      })().catch((err) =>
        console.error(`[bootstrap] result re-delivery failed for ${run.runId}:`, err),
      );
    },
    onRunFailed,
    onRunTerminated: (runId) => productTools.cancelAsksForRun(runId),
    persistRunEvent: (runId, event) => {
      opsStore.appendRunEvent(runId, event.type, event as unknown as Record<string, unknown>);
      return Promise.resolve();
    },
    onMcpMountResult: (result) => {
      mcpRuntimeStatus.record({ ...result, at: Date.now() });
    },
  });

  return { agentRunExecution, sandboxProxy };
}
