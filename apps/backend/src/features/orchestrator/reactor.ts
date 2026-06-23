import type { AgentService } from "../agent/service.js";
import type { ColumnConfigService } from "../column-config/service.js";
import type { DeliverableRow } from "../deliverable/domain.js";
import type { IssueRow } from "../issue/entities.js";
import type { IssueService } from "../issue/service.js";
import type { RunDispatcher } from "../run/dispatcher.js";
import type { RunSupervisor } from "../run/supervisor.js";
import { emitIssueEvent } from "../runtime-ops/emit-issue-event.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { PromptVars } from "./render.js";
import { renderPrompt } from "./render.js";
import { configurableStatuses, nextTransition } from "./transitions.js";

export class OrchestratorAgentMissingError extends Error {
  constructor(agentId: string, issueId: string) {
    super(`Orchestrator: agent not found or archived: ${agentId} (issue ${issueId})`);
    this.name = "OrchestratorAgentMissingError";
  }
}

export class OrchestratorColumnConfigMissingError extends Error {
  constructor(from: string, issueId: string) {
    super(`Orchestrator: no ColumnConfig for status "${from}" (issue ${issueId})`);
    this.name = "OrchestratorColumnConfigMissingError";
  }
}

export interface OrchestratorDeps {
  issueSvc: IssueService;
  agentSvc: AgentService;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  buildSpec: (agentId: string, threadId: string, input: string) => Promise<Record<string, unknown>>;
  idGen: () => string;
  columnConfigSvc: ColumnConfigService;
  deliverableSvc: { listByIssue(issueId: string): DeliverableRow[] };
  dispatcher: RunDispatcher;
  /** M19: Narrow interface for reading auto-orchestrate toggle. */
  projectSvc: { getById(id: string): { autoOrchestrate: boolean; projectId: string } };
  /** M19 Fix 2: Conversation port for lazy agent membership. */
  convPort?: {
    addMember(input: {
      memberId: string;
      conversationId: string;
      kind: "agent" | "human";
      agentId?: string | null;
      displayName?: string | null;
      joinedAt: number;
    }): { created: boolean };
  };
  now?: () => number;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const {
    issueSvc,
    agentSvc,
    supervisor: _supervisor,
    opsStore,
    buildSpec,
    idGen,
    columnConfigSvc,
    deliverableSvc,
    dispatcher,
    projectSvc,
    convPort,
  } = deps;

  /** Build a nested PromptVars dict from issue creation info + accumulated deliverables.
   *  Same kind → latest wins (listByIssue returns created_at ASC → later items overwrite earlier).
   *  R4: fields and ref are separate namespaces — {{deliverables.<kind>.fields.<key>}} and {{deliverables.<kind>.ref}}.
   *  R5: Object.create(null) prevents prototype pollution from agent-controlled kind strings. */
  function buildPromptVars(issue: IssueRow, deliverables: DeliverableRow[]): PromptVars {
    const byKind: Record<string, { fields: Record<string, string>; ref: string }> =
      Object.create(null);
    for (const d of deliverables) {
      byKind[d.kind] = { fields: d.fields, ref: d.ref ?? "" };
    }
    const isRework = !!byKind.rework_feedback;
    return {
      // Structured access for {{#if isRework}} / {{issue.title}} / {{deliverables.plan.fields.summary}}
      issue: {
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        id: issue.issueId,
        status: issue.status,
        estimatedCompletionAt: issue.estimatedCompletionAt,
      },
      deliverables: byKind,
      rework: { note: byKind.rework_feedback?.fields?.note ?? "" },
      attempt: isRework ? 2 : 1,
      isRework,
      // Backward-compatible flat keys: existing templates ({{title}}/{{issueId}}) still work
      title: issue.title,
      issueId: issue.issueId,
    };
  }

  /** 为某个 Issue 的当前 status 起对应转移的那一棒。
   *  缺转移（终态）→ 静默停止；缺 agent → 抛错、不起 run、Issue 不推进。 */
  async function startStep(issue: IssueRow): Promise<{ runId: string } | null> {
    const table = columnConfigSvc.transitionsForProject(issue.projectId);
    const t = nextTransition(table, issue.status);
    if (!t) {
      // Fix 9: if status is configurable but has no transition, that's a
      // missing-config error — surface it immediately instead of silently stopping.
      if ((configurableStatuses() as string[]).includes(issue.status)) {
        throw new OrchestratorColumnConfigMissingError(issue.status, issue.issueId);
      }
      return null;
    }

    // getById 对 missing 或 archived 均抛 AgentNotFoundError；统一 catch 为 null
    const agent = await agentSvc.getById(t.agentId).catch(() => null);
    if (!agent) {
      throw new OrchestratorAgentMissingError(t.agentId, issue.issueId);
    }

    const runId = idGen();
    const vars = buildPromptVars(issue, deliverableSvc.listByIssue(issue.issueId));
    const prompt = renderPrompt(t.promptTemplate, vars);
    // M19: threadId = <issueId>:<agentId> — runs through conversation projection
    const threadId = `${issue.issueId}:${t.agentId}`;
    const spec = await buildSpec(t.agentId, threadId, prompt);

    // M19 Fix 2: Ensure agent is a member of the issue conversation (idempotent).
    if (convPort) {
      convPort.addMember({
        memberId: t.agentId,
        conversationId: issue.issueId,
        kind: "agent",
        agentId: t.agentId,
        displayName: agent.name,
        joinedAt: (deps.now ?? Date.now)(),
      });
    }

    await dispatcher.dispatch({
      kind: "orchestrator",
      runId,
      threadId,
      spec,
      opts: {
        surfaceContext: {
          surface: "orchestrator",
          conversationId: "",
          runId,
          capabilities: ["submit_deliverable"],
          issue: { issueId: issue.issueId, fromStatus: issue.status },
        },
      },
      origin: {
        issueId: issue.issueId,
        conversationId: "",
        sourceLedgerSeq: 0,
        agentMemberId: t.agentId,
        surface: "orchestrator",
        traceId: "",
        traceparent: "",
        idempotencyKey: runId,
        fromStatus: issue.status,
      },
    });

    emitIssueEvent(opsStore, issue.issueId, "run.started", {
      runId,
      fromStatus: issue.status,
      agentId: t.agentId,
    });

    return { runId };
  }

  /** 注册为 supervisor.onRunComplete 监听器。只处理 issue-driven 的成功终态。 */
  async function onRunComplete(
    _threadId: string,
    runId: string,
    status: string,
    kind: string,
  ): Promise<void> {
    if (kind === "reflect") return;

    const origin = opsStore.getRunOrigin(runId);
    // M19: gate by explicit origin_kind — only orchestrator runs advance state
    if (origin?.originKind !== "orchestrator" || !origin.issueId) return;
    const issueId = origin.issueId;

    emitIssueEvent(opsStore, issueId, "run.ended", {
      runId,
      fromStatus: origin.fromStatus,
      status,
    });

    if (status !== "succeeded") {
      console.warn(
        `[orchestrator] run ${runId} for issue ${issueId} ended ${status}; not advancing`,
      );
      return;
    }

    const issue = issueSvc.port.getIssue(issueId);
    if (!issue) return;

    // M19: Auto-orchestrate guard — if the project has auto-advance disabled,
    // skip the entire state machine. Run still lands in ledger/Coding Thread.
    // getById is synchronous (returns or throws) — use try/catch, not .catch().
    const project = (() => {
      try {
        return projectSvc.getById(issue.projectId);
      } catch {
        return null;
      }
    })();
    if (!project?.autoOrchestrate) return;

    // Idempotency guard: if the issue has already moved past the status this run
    // was started at, a prior delivery already advanced it — skip (CAS alone can't
    // catch this because the current status is a valid from-state for the NEXT transition).
    const fromStatus = origin.fromStatus;
    // fromStatus missing (empty string) = origin unreliable, skip conservatively
    if (fromStatus === "" || issue.status !== fromStatus) return;

    const table = columnConfigSvc.transitionsForProject(issue.projectId);
    const t = nextTransition(table, issue.status);
    if (!t) return;

    let advanced: IssueRow;
    try {
      advanced = issueSvc.applyTransition(issueId, t.to);
      emitIssueEvent(opsStore, issueId, "status.advanced", {
        from: issue.status,
        to: t.to,
        by: "reactor",
      });
    } catch (err) {
      console.warn(`[orchestrator] applyTransition skipped for ${issueId}: ${String(err)}`);
      return;
    }

    try {
      await startStep(advanced);
    } catch (err) {
      console.error(`[orchestrator] failed to start next step for ${issueId}: ${String(err)}`);
    }
  }

  return { startStep, onRunComplete };
}
