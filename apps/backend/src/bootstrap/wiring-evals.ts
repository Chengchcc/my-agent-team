import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, type Message } from "@chengchenccc/message";
import { parseWorkflow } from "@chengchenccc/workflow";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import { finalAnswerMessage } from "../features/agent-run/execution-input.js";
import type { AgentRunPort } from "../features/agent-run/index.js";
import type { BackendRunOutcome } from "../features/agent-run/protocol/index.js";
import type { ConversationPort } from "../features/conversation/ports.js";
import type { ConversationService } from "../features/conversation/service.js";
import {
  createEvalService,
  createFsEvalSuiteStore,
  type EvalService,
  EvalSqliteStore,
  type ToolInvocationFact,
} from "../features/evals/index.js";
import { extractSkillsFromMessages } from "../features/runtime-ops/telemetry-helpers.js";
import type { WorkflowExecutionService } from "../features/workflow/service.js";

const EVAL_RUN_TIMEOUT_MS = 180_000;
const POLL_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectToolsFromMessages(messages: readonly Message[] | undefined): ToolInvocationFact[] {
  if (!messages) return [];
  const errorsByCall = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b.type === "tool_result" && b.is_error && b.tool_use_id) {
        errorsByCall.add(b.tool_use_id);
      }
    }
  }
  const tools: ToolInvocationFact[] = [];
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b.type === "tool_use") {
        let inputText: string;
        try {
          inputText = JSON.stringify(b.input ?? {});
        } catch {
          inputText = "";
        }
        tools.push({
          toolName: b.name,
          inputText,
          isError: b.id ? errorsByCall.has(b.id) : false,
        });
      }
    }
  }
  return tools;
}

export interface EvalsWiringDeps {
  readonly config: BackendConfig;
  readonly db: Database;
  readonly ulid: () => string;
  readonly agentSvc: AgentService;
  readonly agentRunPort: AgentRunPort;
  readonly convPort: ConversationPort;
  readonly convSvc: ConversationService;
  readonly workflowExecutionService: WorkflowExecutionService;
}

/** ADR 0085: Wire `<dataDir>/evals/*.eval.json` Git store, SQLite experiment
 *  store, and isolated execution hooks reusing the real Agent Run & Workflow
 *  pipelines. */
export function wireEvals(deps: EvalsWiringDeps): { evalSvc: EvalService } {
  const { config, db, ulid, agentSvc, agentRunPort, convPort, convSvc, workflowExecutionService } =
    deps;

  const suiteStore = createFsEvalSuiteStore(join(config.dataDir, "evals"));
  const sqliteStore = new EvalSqliteStore(db);

  async function resolveEvalAgentId(
    targetKind: "skill" | "workflow" | "agent",
    targetRef: string,
    explicitAgentId?: string,
  ): Promise<string> {
    if (explicitAgentId) return explicitAgentId;
    if (targetKind === "agent") return targetRef;
    const all = await agentSvc.list();
    const front = all.find((a) => a.config.role !== "worker") ?? all[0];
    if (!front) throw new Error("No agent available to execute eval case");
    return front.id;
  }

  const evalSvc = createEvalService({
    db,
    suiteStore,
    sqliteStore,
    ulid,
    execution: {
      runAgentCase: async ({ evalRunId, suite, evalCase, trialIndex, modelOverride }) => {
        const agentId = await resolveEvalAgentId(
          suite.target.kind,
          suite.target.ref,
          suite.target.agentId,
        );
        const convId = `eval:${evalRunId}:${evalCase.id}:${trialIndex}`;
        const existing = convPort.getConversation(convId);
        if (!existing) {
          convPort.createConversation({
            conversationId: convId,
            agentId,
            origin: "eval",
            createdAt: Date.now(),
          });
        }
        const messageText =
          typeof evalCase.input === "string" ? evalCase.input : JSON.stringify(evalCase.input);

        const posted = await convSvc.postMessage({
          conversationId: convId,
          content: messageText,
          authorization: `eval:${evalRunId}`,
          ...(modelOverride
            ? { modelOverride: { backendKind: "oma", modelId: modelOverride } }
            : {}),
        });
        const runId = posted.triggeredRuns[0]?.runId;
        if (!runId) {
          throw new Error("Eval message did not trigger an Agent Run");
        }

        const deadline = Date.now() + EVAL_RUN_TIMEOUT_MS;
        let run = await agentRunPort.getRun(runId);
        while (
          run &&
          (run.status === "running" || run.status === "waiting") &&
          Date.now() < deadline
        ) {
          await sleep(POLL_MS);
          run = await agentRunPort.getRun(runId);
        }

        const outcome = (run?.terminalResult ?? null) as BackendRunOutcome | null;
        const messages = outcome?.messages ?? [];
        const finalMsg = finalAnswerMessage(messages);
        const outputText = finalMsg ? extractText(finalMsg) : "";
        const tools = collectToolsFromMessages(messages);
        const skills = extractSkillsFromMessages(messages).map((s) => s.skillName);

        // Include any skill_activated / product_tool_call recorded in SQLite
        const evSkills = db
          .query(
            `SELECT json_extract(data, '$.skillName') AS name
               FROM agent_run_event
              WHERE run_id = ? AND type = 'skill_activated'`,
          )
          .all(runId) as Array<{ name: string | null }>;
        for (const s of evSkills) {
          if (s.name && !skills.includes(s.name)) skills.push(s.name);
        }
        const ptCalls = db
          .query(`SELECT tool_name AS toolName, status FROM product_tool_call WHERE run_id = ?`)
          .all(runId) as Array<{ toolName: string; status: string }>;
        for (const pt of ptCalls) {
          if (!tools.some((t) => t.toolName === pt.toolName)) {
            tools.push({
              toolName: pt.toolName,
              inputText: "",
              isError: pt.status === "failed" || pt.status === "error",
            });
          }
        }

        const usage = outcome?.usage;
        const duration =
          run && run.terminalAt != null
            ? Math.max(0, run.terminalAt - run.createdAt)
            : EVAL_RUN_TIMEOUT_MS;

        return {
          runId,
          observation: {
            input: evalCase.input,
            outputText,
            status: run?.status ?? "timeout",
            error:
              outcome && "error" in outcome && typeof outcome.error === "string"
                ? outcome.error
                : run?.status === "running" || run?.status === "waiting"
                  ? "Eval trial timed out"
                  : null,
            activeDurationMs: duration,
            toolCalls: tools.length,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            costUsd: usage?.costUsd ?? 0,
            skillsActivated: skills,
            tools,
          },
        };
      },

      runWorkflowCase: async ({ evalRunId, suite, evalCase }) => {
        const wfPath = join(config.dataDir, "workflows", `${suite.target.ref}.workflow.json`);
        if (!existsSync(wfPath)) {
          throw new Error(`Workflow definition "${suite.target.ref}" not found`);
        }
        const def = parseWorkflow(JSON.parse(readFileSync(wfPath, "utf8")));
        const wfInput =
          typeof evalCase.input === "object" && evalCase.input !== null
            ? evalCase.input
            : { message: evalCase.input };

        const execution = await workflowExecutionService.startExecution({
          workflowId: suite.target.ref,
          definition: def,
          input: wfInput,
          triggeredBy: `eval:${evalRunId}`,
        });
        const executionId = execution.executionId;
        const startedAt = Date.now();
        const deadline = startedAt + EVAL_RUN_TIMEOUT_MS;

        let current = await workflowExecutionService.getExecution(executionId);
        while (current && current.status === "running" && Date.now() < deadline) {
          await sleep(POLL_MS);
          current = await workflowExecutionService.getExecution(executionId);
        }

        const nodeRuns = db
          .query(
            `SELECT node_id AS nodeId, run_id AS runId, status, output
               FROM workflow_node_run
              WHERE execution_id = ?
              ORDER BY seq ASC`,
          )
          .all(executionId) as Array<{
          nodeId: string;
          runId: string | null;
          status: string;
          output: string | null;
        }>;
        const budgetEv = db
          .query(
            `SELECT 1 AS hit FROM workflow_execution_event
              WHERE execution_id = ? AND event = 'budget_exhausted' LIMIT 1`,
          )
          .get(executionId) as { hit: number } | null;

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let costUsd = 0;
        let toolCalls = 0;
        const tools: ToolInvocationFact[] = [];
        const skills = new Set<string>();
        let lastOutputText = "";

        for (const nr of nodeRuns) {
          if (nr.output) lastOutputText = nr.output;
          if (!nr.runId) continue;
          const run = await agentRunPort.getRun(nr.runId);
          const outcome = (run?.terminalResult ?? null) as BackendRunOutcome | null;
          if (outcome?.usage) {
            inputTokens += outcome.usage.inputTokens ?? 0;
            outputTokens += outcome.usage.outputTokens ?? 0;
            cacheReadTokens += outcome.usage.cacheReadTokens ?? 0;
            costUsd += outcome.usage.costUsd ?? 0;
          }
          const runTools = collectToolsFromMessages(outcome?.messages);
          toolCalls += runTools.length;
          tools.push(...runTools);
          for (const sk of extractSkillsFromMessages(outcome?.messages)) {
            skills.add(sk.skillName);
          }
        }

        const duration =
          current?.terminalAt != null
            ? Math.max(0, current.terminalAt - current.createdAt)
            : Date.now() - startedAt;

        return {
          workflowExecutionId: executionId,
          runId: nodeRuns.find((n) => n.runId)?.runId ?? null,
          observation: {
            input: evalCase.input,
            outputText: lastOutputText,
            status: current?.status ?? "timeout",
            error: current?.error ?? null,
            activeDurationMs: duration,
            toolCalls,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            costUsd,
            skillsActivated: [...skills],
            tools,
            workflow: {
              status: current?.status ?? "timeout",
              exit: current?.exit ?? null,
              visitedNodes: nodeRuns.map((n) => n.nodeId),
              budgetExhausted: Boolean(budgetEv?.hit),
            },
          },
        };
      },

      graders: {
        runCommand: async ({ command, cwd, timeoutMs }) => {
          const proc = Bun.spawn(["bash", "-lc", command], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
          const timer = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* ignore */
            }
          }, timeoutMs);
          try {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            return { exitCode, stdout, stderr };
          } finally {
            clearTimeout(timer);
          }
        },
      },
    },
  });

  return { evalSvc };
}
