import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/service.js";
import type { ColumnConfigService } from "../column-config/service.js";
import type { DeliverableRow } from "../deliverable/domain.js";
import type { IssueRow } from "../issue/entities.js";
import type { IssueService } from "../issue/service.js";
import { emitIssueEvent } from "../runtime-ops/emit-issue-event.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { SessionFactory } from "../span/session-factory.js";
import { executeAgentRun, makeRunDeps } from "../span/span-executor.js";
import type { SpanSupervisor } from "../span/supervisor.js";
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

// ─── buildPromptVars (pure, module-level) ──────────────────

/** Build a nested PromptVars dict from issue + accumulated deliverables.
 *  Same kind → latest wins. R4: fields/ref separate namespaces.
 *  R5: Object.create(null) prevents prototype pollution. */
export function buildPromptVars(issue: IssueRow, deliverables: DeliverableRow[]): PromptVars {
  const byKind: Record<string, { fields: Record<string, string>; ref: string }> =
    Object.create(null);
  for (const d of deliverables) {
    byKind[d.kind] = { fields: d.fields, ref: d.ref ?? "" };
  }
  const isRework = !!byKind.rework_feedback;
  return {
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
    title: issue.title,
    issueId: issue.issueId,
  };
}

// ─── StepRunner ────────────────────────────────────────────

export interface StepRunnerDeps {
  agentSvc: Pick<AgentService, "getById">;
  columnConfigSvc: ColumnConfigService;
  deliverableSvc: { listByIssue(issueId: string): DeliverableRow[] };
  opsStore: RuntimeOpsStore;
  idGen: () => string;
  config: BackendConfig;
  supervisor: SpanSupervisor;
  convPort?: OrchestratorDeps["convPort"];
  now?: () => number;
  sessionFactory?: SessionFactory;
}

export function createStepRunner(d: StepRunnerDeps) {
  async function startStep(issue: IssueRow): Promise<{ spanId: string } | null> {
    const table = d.columnConfigSvc.transitionsForProject(issue.projectId);
    const t = nextTransition(table, issue.status);
    if (!t) {
      if ((configurableStatuses() as string[]).includes(issue.status)) {
        throw new OrchestratorColumnConfigMissingError(issue.status, issue.issueId);
      }
      return null;
    }

    const agent = await d.agentSvc.getById(t.agentId).catch(() => null);
    if (!agent) {
      throw new OrchestratorAgentMissingError(t.agentId, issue.issueId);
    }

    const spanId = d.idGen();
    const vars = buildPromptVars(issue, d.deliverableSvc.listByIssue(issue.issueId));
    const prompt = renderPrompt(t.promptTemplate, vars);
    const sessionId = `${issue.issueId}:${t.agentId}`;

    if (d.convPort) {
      d.convPort.addMember({
        memberId: t.agentId,
        conversationId: issue.issueId,
        kind: "agent",
        agentId: t.agentId,
        displayName: agent.name,
        joinedAt: (d.now ?? Date.now)(),
      });
    }

    const runDeps = makeRunDeps({
      config: d.config,
      supervisor: d.supervisor,
      opsStore: d.opsStore,
      agentSvc: d.agentSvc as AgentService,
      sessionFactory: d.sessionFactory,
    });
    await executeAgentRun(runDeps, {
      spanId,
      sessionId: sessionId,
      agentId: t.agentId,
      input: prompt,
      origin: { kind: "orchestrator", issueId: issue.issueId, fromStatus: issue.status },
    });

    emitIssueEvent(d.opsStore, issue.issueId, "run.started", {
      spanId,
      fromStatus: issue.status,
      agentId: t.agentId,
    });

    return { spanId };
  }

  return { startStep };
}

// ─── TransitionReactor ─────────────────────────────────────

export interface TransitionReactorDeps {
  issueSvc: IssueService;
  projectSvc: { getById(id: string): { autoOrchestrate: boolean; projectId: string } };
  opsStore: RuntimeOpsStore;
  columnConfigSvc: ColumnConfigService;
  stepRunner: { startStep(i: IssueRow): Promise<{ spanId: string } | null> };
}

export function createTransitionReactor(d: TransitionReactorDeps) {
  async function onRunComplete(
    _sessionId: string,
    spanId: string,
    status: string,
    kind: string,
  ): Promise<void> {
    if (kind === "reflect") return;

    const origin = d.opsStore.getSpanOrigin(spanId);
    if (origin?.originKind !== "orchestrator" || !origin.issueId) return;
    const issueId = origin.issueId;

    emitIssueEvent(d.opsStore, issueId, "run.ended", {
      spanId,
      fromStatus: origin.fromStatus,
      status,
    });

    if (status !== "succeeded") {
      console.warn(
        `[orchestrator] run ${spanId} for issue ${issueId} ended ${status}; not advancing`,
      );
      return;
    }

    const issue = d.issueSvc.port.getIssue(issueId);
    if (!issue) return;

    const project = (() => {
      try {
        return d.projectSvc.getById(issue.projectId);
      } catch {
        return null;
      }
    })();
    if (!project?.autoOrchestrate) return;

    const fromStatus = origin.fromStatus;
    if (fromStatus === "" || issue.status !== fromStatus) return;

    const table = d.columnConfigSvc.transitionsForProject(issue.projectId);
    const t = nextTransition(table, issue.status);
    if (!t) {
      if ((configurableStatuses() as string[]).includes(issue.status)) {
        console.error(
          `[orchestrator] no ColumnConfig for configurable status "${issue.status}" on issue ${issueId} — auto-advance stalled`,
        );
      }
      return;
    }

    let advanced: IssueRow;
    try {
      advanced = d.issueSvc.applyTransition(issueId, t.to);
      emitIssueEvent(d.opsStore, issueId, "status.advanced", {
        from: issue.status,
        to: t.to,
        by: "reactor",
      });
    } catch (err) {
      console.warn(`[orchestrator] applyTransition skipped for ${issueId}: ${String(err)}`);
      return;
    }

    try {
      await d.stepRunner.startStep(advanced);
    } catch (err) {
      console.error(`[orchestrator] failed to start next step for ${issueId}: ${String(err)}`);
    }
  }

  return { onRunComplete };
}

// ─── Thin shell (keeps main.ts wiring unchanged) ───────────

export interface OrchestratorDeps {
  config: BackendConfig;
  issueSvc: IssueService;
  agentSvc: AgentService;
  supervisor: SpanSupervisor;
  opsStore: RuntimeOpsStore;
  idGen: () => string;
  columnConfigSvc: ColumnConfigService;
  deliverableSvc: { listByIssue(issueId: string): DeliverableRow[] };
  projectSvc: { getById(id: string): { autoOrchestrate: boolean; projectId: string } };
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
  sessionFactory?: SessionFactory;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const stepRunner = createStepRunner({
    agentSvc: deps.agentSvc,
    columnConfigSvc: deps.columnConfigSvc,
    deliverableSvc: deps.deliverableSvc,
    opsStore: deps.opsStore,
    idGen: deps.idGen,
    config: deps.config,
    supervisor: deps.supervisor,
    convPort: deps.convPort,
    now: deps.now,
    sessionFactory: deps.sessionFactory,
  });

  const reactor = createTransitionReactor({
    issueSvc: deps.issueSvc,
    projectSvc: deps.projectSvc,
    opsStore: deps.opsStore,
    columnConfigSvc: deps.columnConfigSvc,
    stepRunner,
  });

  return {
    startStep: stepRunner.startStep,
    onRunComplete: reactor.onRunComplete,
  };
}
