import type { Database } from "bun:sqlite";
import { taskCardOf } from "./tasks.js";
import { resolveModelAlias } from "@chengchenccc/ai";
import { Elysia, t } from "elysia";
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
      const ref = JSON.parse(g.model_ref) as { backendKind: string; modelId: string };
      const c = costs.get(`${ref.backendKind}/${resolveModelAlias(ref.modelId)}`);
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

  return new Elysia()
    .get(
      "/api/agent-runs",
      ({ query }) => {
        const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 500);
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
        const sql = `SELECT ar.run_id, ar.conversation_id, ar.agent_id, ar.status,
                            ar.model_ref, ar.created_at, ar.terminal_at, ar.terminal_result
                       FROM agent_run ar
                       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                       ORDER BY ar.created_at DESC
                       LIMIT ?`;
        const rows = db.query(sql).all(...args, limit) as Array<{
          run_id: string;
          conversation_id: string;
          agent_id: string;
          status: string;
          model_ref: string;
          created_at: number;
          terminal_at: number | null;
          terminal_result: string | null;
        }>;
        return {
          runs: rows.map((r) => {
            const outcome = r.terminal_result
              ? (JSON.parse(r.terminal_result) as BackendRunOutcome)
              : null;
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
          limit: t.Optional(t.String()),
        }),
      },
    )
    .get("/api/tasks", ({ query }) => {
      // Raft #3 task cards: the input queue's semantics, made visible. A
      // task IS a queued input plus its run — read-only projection, no new
      // execution semantics; statuses are derived (tasks.ts) so the run
      // state machine stays the only truth.
      const limit = Math.min(Number(query.limit ?? 100) || 100, 300);
      const rows = db
        .query(
          `SELECT q.input_id, q.status AS queue_status, q.run_id, q.created_at, q.message,
                  ar.status AS run_status, ar.agent_id, ar.conversation_id,
                  c.title AS conversation_title
             FROM branch_input_queue q
             LEFT JOIN agent_run ar ON ar.run_id = q.run_id
             LEFT JOIN conversation c ON c.conversation_id = ar.conversation_id
            ORDER BY q.created_at DESC
            LIMIT ?`,
        )
        .all(limit) as Array<{
        input_id: string;
        queue_status: string;
        run_id: string | null;
        created_at: number;
        message: string;
        run_status: string | null;
        agent_id: string | null;
        conversation_id: string | null;
        conversation_title: string | null;
      }>;
      const tasks = rows.map((r) =>
        taskCardOf({
          queue: {
            inputId: r.input_id,
            status: r.queue_status,
            runId: r.run_id,
            createdAt: r.created_at,
            message: r.message,
          },
          run:
            r.run_status === null
              ? null
              : { status: r.run_status, agentId: r.agent_id, conversationId: r.conversation_id },
          conversationTitle: r.conversation_title,
        }),
      );
      return { tasks };
    })
    .get("/api/pending-actions", () => {
      // Global HITL read model: one row per thing a human can still answer.
      // Terminal settles cancel their actions, so the active-run join is
      // belt-and-suspenders against a cancelled row racing the sweep. The
      // Today page and the TopBar bell read this instead of fan-out run
      // detail calls.
      const rows = db
        .query(
          `SELECT pa.action_id, pa.run_id, pa.kind, pa.payload, pa.created_at,
                  ar.conversation_id, ar.agent_id, ar.status AS run_status
             FROM pending_action pa
             JOIN agent_run ar ON ar.run_id = pa.run_id
            WHERE pa.status = 'pending'
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
        conversation_id: string;
        agent_id: string;
        run_status: string;
      }>;
      return {
        actions: rows.map((r) => ({
          actionId: r.action_id,
          runId: r.run_id,
          conversationId: r.conversation_id,
          agentId: r.agent_id,
          runStatus: r.run_status,
          kind: r.kind,
          payload: JSON.parse(r.payload) as Record<string, unknown>,
          createdAt: r.created_at,
        })),
      };
    })
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
    .post("/api/agent-runs/:runId/approval", async ({ params: { runId }, body, set }) => {
      const run = await agentRunService.getRun(runId);
      if (!run) {
        set.status = 404;
        return { error: "Run not found" };
      }
      const payload = body as { callId?: unknown; decision?: unknown } | undefined;
      const isTerminal = TERMINAL_STATUSES.includes(run.status);
      const isAllow = payload?.decision === "allow";
      const isDeny = payload?.decision === "deny";
      const hasValidDecision = typeof payload?.callId === "string" && (isAllow || isDeny);
      if (isTerminal) {
        set.status = 409;
        return { error: `Run ${runId} is ${run.status}` };
      }
      if (!hasValidDecision) {
        set.status = 400;
        return { error: "body must be { callId: string, decision: 'allow' | 'deny' }" };
      }
      try {
        await agentRunExecution.resolveApproval(
          runId,
          payload.callId as string,
          payload.decision as "allow" | "deny",
        );
      } catch (err) {
        if (err instanceof ApprovalNotApplicableError) {
          set.status = 409;
          return { error: "This approval is no longer waiting for an answer" };
        }
        throw err;
      }
      return { ok: true, runId, callId: payload.callId, decision: payload.decision };
    });
}
