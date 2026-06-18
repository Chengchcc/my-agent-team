import type { IssueRow } from "../issue/entities.js";
import type { IssueService } from "../issue/service.js";
import type { AgentService } from "../agent/service.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { renderPrompt } from "./render.js";
import { nextTransition, TRANSITIONS } from "./transitions.js";

export class OrchestratorAgentMissingError extends Error {
  constructor(agentId: string, issueId: string) {
    super(`Orchestrator: agent not found or archived: ${agentId} (issue ${issueId})`);
    this.name = "OrchestratorAgentMissingError";
  }
}

export interface OrchestratorDeps {
  issueSvc: IssueService;
  agentSvc: AgentService;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  buildSpec: (agentId: string, threadId: string, input: string) => Promise<Record<string, unknown>>;
  idGen: () => string;
  now?: () => number;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { issueSvc, agentSvc, supervisor, opsStore, buildSpec, idGen } = deps;

  /** 为某个 Issue 的当前 status 起对应转移的那一棒。
   *  缺转移（终态）→ 静默停止；缺 agent → 抛错、不起 run、Issue 不推进。 */
  async function startStep(issue: IssueRow): Promise<{ runId: string } | null> {
    const t = nextTransition(TRANSITIONS, issue.status);
    if (!t) return null;

    // getById 对 missing 或 archived 均抛 AgentNotFoundError；统一 catch 为 null
    const agent = await agentSvc.getById(t.agentId).catch(() => null);
    if (!agent) {
      throw new OrchestratorAgentMissingError(t.agentId, issue.issueId);
    }

    const runId = idGen();
    const prompt = renderPrompt(t.promptTemplate, { title: issue.title, issueId: issue.issueId });
    const spec = await buildSpec(t.agentId, issue.threadId, prompt);

    await supervisor.startMainRun(runId, issue.threadId, spec);

    opsStore.insertRunOrigin({
      runId,
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: t.agentId,
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: `issue:${issue.issueId}:${issue.status}:run`,
      createdAt: (deps.now ?? Date.now)(),
    });

    return { runId };
  }

  /** 注册为 supervisor.onRunComplete 监听器。只处理 issue-driven 的成功终态。 */
  async function onRunComplete(
    threadId: string,
    runId: string,
    status: string,
    kind: string,
  ): Promise<void> {
    if (kind === "reflect") return;

    const origin = opsStore.getRunOrigin(runId);
    const issueId = origin?.issueId;
    if (!issueId) return;

    if (status !== "succeeded") {
      console.warn(
        `[orchestrator] run ${runId} for issue ${issueId} ended ${status}; not advancing`,
      );
      return;
    }

    const issue = issueSvc.port.getIssue(issueId);
    if (!issue) return;

    // Idempotency guard: if the issue has already moved past the status this run
    // was started at, a prior delivery already advanced it — skip (CAS alone can't
    // catch this because the current status is a valid from-state for the NEXT transition).
    const fromStatus = origin.idempotencyKey?.split(":")[2];
    if (fromStatus && issue.status !== fromStatus) return;

    const t = nextTransition(TRANSITIONS, issue.status);
    if (!t) return;

    let advanced: IssueRow;
    try {
      advanced = issueSvc.applyTransition(issueId, t.to);
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
