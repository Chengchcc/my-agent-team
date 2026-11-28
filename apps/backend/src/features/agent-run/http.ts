import type { Database } from "bun:sqlite";
import { resolveModelAlias } from "@chengchenccc/ai";
import { Elysia, t } from "elysia";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import { parseBoundedLimit, parseBoundedOffset } from "../../infra/http-utils.js";
import { type AgentRunExecutionService, ApprovalNotApplicableError } from "./execution.js";
import type { BackendRunOutcome } from "./protocol/index.js";
import type { AgentRunService } from "./service.js";

const ACTIVE_STATUSES = ["running", "waiting", "commit_failed"];
const TERMINAL_STATUSES = ["completed", "failed", "aborted", "timeout"];

/** Tool-result gate (P2): the model's own PASS/FAIL text is not trusted.
 *  Verdict comes from tool_result.is_error flags in the committed run. */
function deriveVerdict(outcome: BackendRunOutcome | null): "pass" | "fail" | "unknown" {
  if (outcome?.status !== "completed") return "unknown";
  for (const message of outcome.messages ?? []) {
    for (const block of message.blocks ?? []) {
      if (block.type === "tool_result" && block.is_error) return "fail";
    }
  }
  return "pass";
}

/** Verification-command heuristic: an INVOCATION of a test/typecheck/lint/
 * build runner. Deliberately narrow — bare name substrings (`cat
 * eslint.config.ts`, `ls .pytest_cache`) must NOT match: false negatives
 * understate `ranVerification`, false positives would overstate it. */
const VERIFICATION_COMMAND_RE =
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build)\b|\btsc\b|\b(bunx?|npx|yarn)\s+(vitest|pytest|eslint|biome)\b|\bcargo\s+(test|clippy|build)\b|\bgo\s+(test|vet)\b/;

export interface RunVerification {
  verdict: "pass" | "fail" | "unknown";
  toolErrorCount: number;
  usedEval: boolean;
  verificationCommands: string[];
  assistantClaimedDone: boolean;
  failureCause: string | null;
}

/** Terminal verification scorecard: objective, read-only facts derived
 *  from the STORED outcome (no LLM judge, no rubric tables). Three
 *  questions: did the agent run verification, did it error, and is "done"
 *  tool-supported (verdict) or just the model's word. */
export function deriveVerification(outcome: BackendRunOutcome | null): RunVerification {
  if (!outcome) {
    return {
      verdict: "unknown",
      toolErrorCount: 0,
      usedEval: false,
      verificationCommands: [],
      assistantClaimedDone: false,
      failureCause: null,
    };
  }
  let toolErrorCount = 0;
  let usedEval = false;
  let assistantClaimedDone = false;
  const verificationCommands: string[] = [];
  for (const message of outcome.messages ?? []) {
    if (message.role === "assistant") {
      // A "done" claim is the run's FINAL word: the last assistant message
      // actually carrying text. Intermediate tool_use turns never count.
      assistantClaimedDone = message.blocks?.some((b) => b.type === "text") ?? false;
    }
    for (const block of message.blocks ?? []) {
      if (block.type === "tool_result" && block.is_error) toolErrorCount++;
      if (block.type === "tool_use") {
        if (block.name === "eval") usedEval = true;
        const input = block.input;
        if (
          block.name === "bash" &&
          typeof input === "object" &&
          input !== null &&
          "command" in input &&
          typeof input.command === "string" &&
          VERIFICATION_COMMAND_RE.test(input.command)
        ) {
          verificationCommands.push(input.command.slice(0, 200));
        }
      }
    }
  }
  return {
    verdict: deriveVerdict(outcome),
    toolErrorCount,
    usedEval,
    verificationCommands,
    assistantClaimedDone,
    failureCause: "error" in outcome && typeof outcome.error === "string" ? outcome.error : null,
  };
}

/** Minimal Agent Run Ops API: Agent Run is the only Product execution
 *  identity. Spans/attempts/checkpoint events remain audit-only. */
export function agentRunRoutes(input: {
  db: Database;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  /** Catalog prices keyed "<backendKind>/<modelId>", USD per million tokens.
   *  Boot builds it once; catalogs are static for the process lifetime. */
  modelCosts: Promise<
    Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  >;
  /** Same gate dispatch refuses runs with, so the summary and the refusal
   *  can never disagree about what was spent. */
  budgetGate?: {
    dailyStatus(): Promise<{ spentUsd: number; capUsd: number | null }>;
  };
  /** ADR 0075 P4b: correct a machine answer. The deployment owns the port
   *  write and the delivery (the worker's room), because both live there. */
  correctAnswer?: (input: {
    actionId: string;
    response: unknown;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** ADR 0082 D5: optional batch label resolver for run DTOs. */
  labelResolver?: EntityLabelResolver;
}) {
  const { db, agentRunService, agentRunExecution, modelCosts } = input;

  type UsageTotals = {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };

  /** Token sums per model_ref, priced via the catalog. Falls back to the
   *  backend-reported usage.costUsd when a model has no catalog price. */
  async function usageTotals(where: string, args: (string | number)[]): Promise<UsageTotals> {
    const groups = db
      .query(
        `SELECT ar.model_ref, COUNT(*) AS runs,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheReadTokens') AS REAL)), 0) AS cacheReadTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheWriteTokens') AS REAL)), 0) AS cacheWriteTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS reportedCostUsd
           FROM agent_run ar
          WHERE ar.terminal_result IS NOT NULL ${where}
          GROUP BY ar.model_ref`,
      )
      .all(...args) as Array<{
      model_ref: string;
      runs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reportedCostUsd: number;
    }>;

    const costs = await modelCosts;
    const t: UsageTotals = {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    for (const g of groups) {
      t.runs += g.runs;
      t.inputTokens += g.inputTokens;
      t.outputTokens += g.outputTokens;
      t.cacheReadTokens += g.cacheReadTokens;
      t.cacheWriteTokens += g.cacheWriteTokens;
      const ref = JSON.parse(g.model_ref) as {
        backendKind: string;
        modelId: string;
        harnessModel?: string;
      };
      const bareKey = resolveModelAlias(ref.harnessModel || ref.modelId);
      const c =
        costs.get(bareKey) ?? costs.get(`${ref.backendKind}/${resolveModelAlias(ref.modelId)}`);
      t.costUsd += c
        ? (g.inputTokens * c.input +
            g.outputTokens * c.output +
            g.cacheReadTokens * c.cacheRead +
            g.cacheWriteTokens * c.cacheWrite) /
          1e6
        : g.reportedCostUsd;
    }
    return t;
  }

  return (
    new Elysia()
      .get(
        "/api/agent-runs",
        ({ query }) => {
          const limit = parseBoundedLimit(query.limit, 50, 500);
          const offset = parseBoundedOffset(query.offset);
          const where: string[] = [];
          const args: (string | number)[] = [];
          if (query.status) {
            where.push("ar.status = ?");
            args.push(query.status);
          }
          if (query.agentId) {
            where.push("ar.agent_id = ?");
            args.push(query.agentId);
          }
          if (query.conversationId) {
            where.push("ar.conversation_id = ?");
            args.push(query.conversationId);
          }
          // ADR 0066: the runs THIS run dispatched - the path from a Lark card
          // (front desk run) down to the worker's own record ("shop floor").
          if (query.parentRunId) {
            where.push("ar.parent_run_id = ?");
            args.push(query.parentRunId);
          }
          const sql = `SELECT ar.run_id, ar.conversation_id, ar.agent_id, ar.status,
                            ar.model_ref, ar.created_at, ar.terminal_at, ar.terminal_result,
                            ar.authorization, ar.parent_run_id, ar.requirement_id,
                            req.title AS requirement_title
                       FROM agent_run ar
                       LEFT JOIN requirement req ON req.requirement_id = ar.requirement_id
                       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                       ORDER BY ar.created_at DESC
                       LIMIT ? OFFSET ?`;
          const rows = db.query(sql).all(...args, limit, offset) as Array<{
            run_id: string;
            conversation_id: string;
            agent_id: string;
            status: string;
            model_ref: string;
            created_at: number;
            terminal_at: number | null;
            terminal_result: string | null;
            authorization: string | null;
            parent_run_id: string | null;
            requirement_id: string | null;
            requirement_title: string | null;
          }>;
          const labelMaps = input.labelResolver?.resolveBatch({
            agentIds: rows.map((r) => r.agent_id),
            conversationIds: rows.map((r) => r.conversation_id),
            requirementIds: rows.map((r) => r.requirement_id),
          });
          return {
            runs: rows.map((r) => {
              const outcome = r.terminal_result
                ? (JSON.parse(r.terminal_result) as BackendRunOutcome)
                : null;
              const labels = input.labelResolver?.labelsFor(
                {
                  agentId: r.agent_id,
                  conversationId: r.conversation_id,
                  requirementId: r.requirement_id,
                },
                labelMaps,
              );
              return {
                runId: r.run_id,
                conversationId: r.conversation_id,
                agentId: r.agent_id,
                status: r.status,
                model: JSON.parse(r.model_ref) as { backendKind: string; modelId: string },
                createdAt: r.created_at,
                terminalAt: r.terminal_at,
                usage: outcome?.usage ?? null,
                error: (outcome as { error?: string } | null)?.error ?? null,
                verdict: deriveVerdict(outcome),
                // ADR 0047/0051: the legitimacy chain the authority ledger reads.
                authorization: r.authorization,
                parentRunId: r.parent_run_id,
                // What the run was for: an execution unit that shows only
                // member+status cannot be told apart from its siblings
                // (audit 2026-11-24).
                requirementId: r.requirement_id,
                requirementTitle: r.requirement_title,
                ...(labels ? { labels } : {}),
              };
            }),
          };
        },
        {
          query: t.Object({
            status: t.Optional(
              t.Union([
                t.Literal("running"),
                t.Literal("waiting"),
                t.Literal("commit_failed"),
                t.Literal("completed"),
                t.Literal("failed"),
                t.Literal("aborted"),
                t.Literal("timeout"),
              ]),
            ),
            agentId: t.Optional(t.String()),
            conversationId: t.Optional(t.String()),
            parentRunId: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      // ─── ADR 0061: the attention axis (derived, read-only) ───
      // Three debts, all computed from rows that already exist:
      //   awaitingYou  a pending question the human owes an answer
      //   waitingAgent the human answered, their run has not settled yet
      //   unread       a terminal notice the human has not looked at
      // Nothing here writes execution state; `seen` only advances read marks.
      .get("/api/attention", () => {
        const awaitingYou = db
          .query(
            // ADR 0075: the inbox is what the HUMAN must answer. A request the
            // dispatcher owns is not waiting on the person — listing it here is
            // how an inbox teaches people to ignore it. Legacy rows with no
            // owner stay visible (they predate the routing).
            `SELECT pa.action_id, pa.run_id, pa.kind, pa.payload, pa.created_at, pa.seen_at,
                  pa.owner, pa.answered_by, pa.evidence,
                  ar.conversation_id, ar.agent_id, ar.status AS run_status
             FROM pending_action pa
             JOIN agent_run ar ON ar.run_id = pa.run_id
            WHERE pa.status = 'pending'
              AND (pa.owner IS NULL OR pa.owner = 'user')
              AND ar.status IN ('running', 'waiting', 'commit_failed')
            ORDER BY pa.created_at DESC
            LIMIT 200`,
          )
          .all() as Array<{
          action_id: string;
          run_id: string;
          kind: string;
          payload: string;
          created_at: number;
          seen_at: number | null;
          owner: string | null;
          answered_by: string | null;
          evidence: string | null;
          conversation_id: string;
          agent_id: string;
          run_status: string;
        }>;
        const waitingAgent = db
          .query(
            `SELECT pa.action_id, pa.run_id, pa.kind, pa.resolved_at, pa.owner, pa.answered_by,
                  ar.conversation_id, ar.agent_id, ar.status AS run_status
             FROM pending_action pa
             JOIN agent_run ar ON ar.run_id = pa.run_id
            WHERE pa.status = 'resolved'
              AND ar.status IN ('running', 'waiting')
            ORDER BY pa.resolved_at DESC
            LIMIT 200`,
          )
          .all() as Array<{
          action_id: string;
          run_id: string;
          kind: string;
          resolved_at: number | null;
          owner: string | null;
          answered_by: string | null;
          conversation_id: string;
          agent_id: string;
          run_status: string;
        }>;
        const unread = db
          .query(
            `SELECT r.run_id, r.conversation_id, r.agent_id, r.status, r.terminal_at,
                    c.title AS conversation_title
               FROM agent_run r
               LEFT JOIN conversation c ON c.conversation_id = r.conversation_id
              WHERE r.terminal_at IS NOT NULL
                AND r.result_notified_at IS NOT NULL
                AND r.result_seen_at IS NULL
              ORDER BY r.terminal_at DESC
              LIMIT 50`,
          )
          .all() as Array<{
          run_id: string;
          conversation_id: string;
          agent_id: string;
          status: string;
          terminal_at: number;
          conversation_title: string | null;
        }>;
        return {
          awaitingYou: awaitingYou.map((r) => ({
            actionId: r.action_id,
            runId: r.run_id,
            conversationId: r.conversation_id,
            agentId: r.agent_id,
            runStatus: r.run_status,
            kind: r.kind,
            payload: JSON.parse(r.payload) as Record<string, unknown>,
            createdAt: r.created_at,
            seen: r.seen_at !== null,
            // ADR 0075: who owes the answer, and (once answered) who gave it
            // and on what evidence — the audit the person needs to trust it.
            owner: r.owner ?? "user",
            answeredBy: r.answered_by,
            evidence: r.evidence === null ? [] : (JSON.parse(r.evidence) as string[]),
          })),
          waitingAgent: waitingAgent.map((r) => ({
            actionId: r.action_id,
            runId: r.run_id,
            conversationId: r.conversation_id,
            agentId: r.agent_id,
            runStatus: r.run_status,
            kind: r.kind,
            resolvedAt: r.resolved_at,
            owner: r.owner ?? null,
            answeredBy: r.answered_by ?? null,
          })),
          unread: unread.map((r) => ({
            runId: r.run_id,
            conversationId: r.conversation_id,
            agentId: r.agent_id,
            status: r.status,
            terminalAt: r.terminal_at,
            // Three finishes by the same member used to read identically
            // ("Finished: Coder"). The room's title says which work it was
            // (audit 2026-11-24).
            title: r.conversation_title,
          })),
        };
      })
      // Opening something marks it looked at. One endpoint, three scopes.
      .post(
        "/api/attention/:actionId/correct",
        async ({ params: { actionId }, body, set }) => {
          if (!input.correctAnswer) {
            set.status = 501;
            return { error: "correction is not configured on this backend" };
          }
          const result = await input.correctAnswer({ actionId, response: body.response });
          if (!result.ok) {
            set.status = 409;
            return { error: result.error };
          }
          return { ok: true, actionId };
        },
        { body: t.Object({ response: t.Unknown() }) },
      )
      .post(
        "/api/attention/seen",
        ({ body }) => {
          const now = Date.now();
          let marked = 0;
          if (body.actionId !== undefined) {
            marked += db
              .query(
                "UPDATE pending_action SET seen_at = ? WHERE action_id = ? AND seen_at IS NULL",
              )
              .run(now, body.actionId).changes;
          }
          if (body.runId !== undefined) {
            marked += db
              .query(
                "UPDATE agent_run SET result_seen_at = ? WHERE run_id = ? AND result_seen_at IS NULL",
              )
              .run(now, body.runId).changes;
          }
          if (body.conversationId !== undefined) {
            marked += db
              .query(
                `UPDATE pending_action SET seen_at = ?
                WHERE seen_at IS NULL
                  AND run_id IN (SELECT run_id FROM agent_run WHERE conversation_id = ?)`,
              )
              .run(now, body.conversationId).changes;
            marked += db
              .query(
                `UPDATE agent_run SET result_seen_at = ?
                WHERE conversation_id = ? AND terminal_at IS NOT NULL AND result_seen_at IS NULL`,
              )
              .run(now, body.conversationId).changes;
          }
          return { marked };
        },
        {
          body: t.Object({
            actionId: t.Optional(t.String({ minLength: 1 })),
            runId: t.Optional(t.String({ minLength: 1 })),
            conversationId: t.Optional(t.String({ minLength: 1 })),
          }),
        },
      )
      // ADR 0061 D3: the human's unsent answer. A draft is not a fact, so it
      // lives beside the ledger, not in it. Reading self-cleans: once the
      // question is gone a draft has no meaning.
      .get(
        "/api/attention/draft",
        ({ query }) => {
          const row = db
            .query("SELECT d.body FROM answer_draft d WHERE d.run_id = ? AND d.call_id = ?")
            .get(query.runId, query.callId) as { body: string } | null;
          if (!row) return { body: null };
          const pending = db
            .query(
              "SELECT 1 AS ok FROM pending_action WHERE run_id = ? AND action_id = ? AND status = 'pending'",
            )
            // A pending action's id is `${runId}:${callId}` (pendingActionId);
            // the draft is keyed by the raw pair the surface already has.
            .get(query.runId, `${query.runId}:${query.callId}`) as { ok: number } | null;
          if (!pending) {
            db.query("DELETE FROM answer_draft WHERE run_id = ? AND call_id = ?").run(
              query.runId,
              query.callId,
            );
            return { body: null };
          }
          return { body: row.body };
        },
        {
          query: t.Object({
            runId: t.String({ minLength: 1 }),
            callId: t.String({ minLength: 1 }),
          }),
        },
      )
      .put(
        "/api/attention/draft",
        ({ body }) => {
          if (body.body === "") {
            db.query("DELETE FROM answer_draft WHERE run_id = ? AND call_id = ?").run(
              body.runId,
              body.callId,
            );
            return { saved: false };
          }
          db.query(
            `INSERT INTO answer_draft (run_id, call_id, body, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, call_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          ).run(body.runId, body.callId, body.body, Date.now());
          return { saved: true };
        },
        {
          body: t.Object({
            runId: t.String({ minLength: 1 }),
            callId: t.String({ minLength: 1 }),
            body: t.String(),
          }),
        },
      )
      .get(
        "/api/usage/summary",
        async ({ query }) => {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          return {
            conversation: query.conversationId
              ? await usageTotals("AND ar.conversation_id = ?", [query.conversationId])
              : null,
            agent: query.agentId ? await usageTotals("AND ar.agent_id = ?", [query.agentId]) : null,
            today: await usageTotals("AND ar.created_at >= ?", [startOfDay.getTime()]),
            // The brake, in the open: capUsd null means no cap is configured.
            budget: input.budgetGate ? await input.budgetGate.dailyStatus() : null,
          };
        },
        {
          query: t.Object({
            conversationId: t.Optional(t.String({ minLength: 1 })),
            agentId: t.Optional(t.String({ minLength: 1 })),
          }),
        },
      )
      .get("/api/agent-runs/:runId", async ({ params: { runId }, set }) => {
        const run = await agentRunService.getRun(runId);
        if (!run) {
          set.status = 404;
          return { error: "Run not found" };
        }
        const inputs = (await agentRunService.listInputs(run.branchId)).filter(
          (i) => i.runId === runId,
        );
        const labels = input.labelResolver?.labelsFor({
          agentId: run.agentId,
          conversationId: run.conversationId,
          requirementId: run.requirementId,
        });
        return {
          run: {
            runId: run.runId,
            branchId: run.branchId,
            conversationId: run.conversationId,
            agentId: run.agentId,
            model: run.modelRef,
            status: run.status,
            verdict: deriveVerdict(run.terminalResult),
            verification: deriveVerification(run.terminalResult),
            configRevision: run.configRevision,
            authorization: run.authorization,
            parentRunId: run.parentRunId,
            requirementId: run.requirementId,
            ...(labels ? { labels } : {}),
            createdAt: run.createdAt,
            terminalAt: run.terminalAt,
            terminalResult: run.terminalResult,
            usage: run.terminalResult?.usage ?? null,
            pendingActions: await agentRunService.listPendingActions(runId).catch(() => []),
          },
          inputs: inputs.map((i) => ({
            inputId: i.inputId,
            mode: i.mode,
            status: i.status,
            runId: i.runId,
            createdAt: i.createdAt,
            deliveredAt: i.deliveredAt,
          })),
        };
      })
      .post("/api/agent-runs/:runId/cancel", async ({ params: { runId }, set }) => {
        const run = await agentRunService.getRun(runId);
        if (!run) {
          set.status = 404;
          return { error: "Run not found" };
        }
        if (TERMINAL_STATUSES.includes(run.status)) {
          return { ok: true, state: "already_terminal", runId, status: run.status };
        }
        if (!ACTIVE_STATUSES.includes(run.status)) {
          set.status = 409;
          return { error: `Run ${runId} is ${run.status}` };
        }
        await agentRunExecution.stop(runId);
        return { ok: true, state: "abort_sent", runId };
      })
      .post("/api/agent-runs/:runId/retry-commit", async ({ params: { runId }, set }) => {
        const run = await agentRunService.getRun(runId);
        if (!run) {
          set.status = 404;
          return { error: "Run not found" };
        }
        if (TERMINAL_STATUSES.includes(run.status)) {
          return { ok: true, state: "already_terminal", runId, status: run.status };
        }
        if (run.status !== "commit_failed") {
          set.status = 409;
          return { error: `Run ${runId} is ${run.status}, not commit_failed` };
        }
        await agentRunExecution.retryTerminalCommit(runId);
        const updated = await agentRunService.getRun(runId);
        return {
          ok: true,
          state: "committed",
          runId,
          status: updated?.status ?? "completed",
        };
      })
      .post(
        "/api/agent-runs/:runId/approval",
        async ({ params: { runId }, body, set }) => {
          const run = await agentRunService.getRun(runId);
          if (!run) {
            set.status = 404;
            return { error: "Run not found" };
          }
          const isTerminal = TERMINAL_STATUSES.includes(run.status);
          const isAllow = body.decision === "allow" || body.decision === "allow_always";
          const isDeny = body.decision === "deny" || body.decision === "deny_always";
          const hasValidDecision = typeof body.callId === "string" && (isAllow || isDeny);
          if (isTerminal) {
            set.status = 409;
            return { error: `Run ${runId} is ${run.status}` };
          }
          if (!hasValidDecision) {
            set.status = 400;
            return {
              error:
                "body must be { callId: string, decision: 'allow' | 'allow_always' | 'deny' | 'deny_always' }",
            };
          }
          try {
            await agentRunExecution.resolveApproval(
              runId,
              body.callId as string,
              body.decision as "allow" | "allow_always" | "deny" | "deny_always",
            );
          } catch (err) {
            if (err instanceof ApprovalNotApplicableError) {
              set.status = 409;
              return { error: "This approval is no longer waiting for an answer" };
            }
            throw err;
          }
          return { ok: true, runId, callId: body.callId, decision: body.decision };
        },
        {
          body: t.Object({
            callId: t.Optional(t.String()),
            decision: t.Optional(t.String()),
          }),
        },
      )
  );
}
