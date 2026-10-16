import {
  type BudgetGateRecord,
  budgetGateNodeId,
  budgetGateOf,
  type CompletionRecord,
  computeNext,
  deriveRework,
  type EngineState,
  type NodeRunner,
  type NodeRunResult,
  planRework,
  type ReworkGrant,
  routeOutgoing,
  type StoreApi,
  validateBySchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@chengchenccc/workflow";
import { HttpError } from "../../infra/errors.js";
import type { WorkflowExecutionRow, WorkflowNodeRunRow } from "./domain.js";
import type { WorkflowExecutionPort } from "./ports.js";

export interface AgentRunnerDeps {
  agentRunService?: {
    enqueueAndAcquire(
      input: Record<string, unknown>,
    ): Promise<{ acquired: boolean; run?: { runId: string } }>;
    getRun(runId: string): Promise<{ status?: string; terminalResult?: unknown } | null>;
  };
  agentRunExecution?: {
    dispatch(runId: string): Promise<void>;
    /** Cancel a run's live child / terminalize a zombie (#workflow-acp). */
    stop?(runId: string): Promise<void>;
  };
  /** Agent-node poll budget; waiting pauses the clock, running burns it.
   *  Injectable so tests can collapse the real 10 minutes. */
  agentNodeTimeoutMs?: number;
  convPort?: {
    getConversation(id: string): unknown;
    createConversation(input: {
      conversationId: string;
      agentId: string;
      origin: string;
      createdAt: number;
      /** Repo-aware agent node: binds the conversation to the attached
       * project so dispatch resolves the agent's real worktree. */
      projectId?: string;
    }): unknown;
  };
  conversationService?: {
    postMessage(input: {
      conversationId: string;
      content: unknown;
      modelOverride?: unknown;
      permissionMode?: "ask" | "auto" | "deny" | "yolo";
    }): Promise<{ triggeredRuns: Array<{ runId: string; queued: boolean }> }>;
  };
  artifactService?: {
    exists(url: string): Promise<boolean>;
  };
  resolveDefaultModel?: (agentId: string) => Promise<unknown>;
  /** The agent's attached project ids (runtime_config.projects) — the
   *  repo-aware agent node validates node.repo against this. */
  agentProjects?: (agentId: string) => Promise<string[]>;
}

export interface WorkflowExecutionServiceDeps extends AgentRunnerDeps {
  port: WorkflowExecutionPort;
  idGen: () => string;
  nodeRunners: Partial<Record<"script" | "human", NodeRunner>>;
}

export interface WorkflowExecutionService {
  runToCompletion(
    executionId: string,
    input: {
      workflowId: string;
      definition: WorkflowDefinition;
      input: Record<string, unknown>;
      triggeredBy?: string;
    },
  ): Promise<WorkflowExecutionRow>;
  startExecution(input: {
    workflowId: string;
    definition: WorkflowDefinition;
    input: Record<string, unknown>;
    triggeredBy?: string;
  }): Promise<WorkflowExecutionRow>;
  resolveHumanTask(
    executionId: string,
    nodeId: string,
    answer: Record<string, unknown>,
  ): Promise<WorkflowExecutionRow>;
  resolveHumanTasks(
    decisions: Array<{
      executionId: string;
      nodeId: string;
      answer?: Record<string, unknown>;
    }>,
  ): Promise<Array<{ executionId: string; ok: boolean; error?: string }>>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  listExecutions(workflowId?: string): Promise<WorkflowExecutionRow[]>;
  deleteExecution(executionId: string): Promise<boolean>;
  cancelExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  listExecutionEvents(
    executionId: string,
  ): Promise<Array<{ seq: number; executionId: string; event: string; data: unknown; ts: number }>>;
  getPendingHuman(
    executionId: string,
    nodeId: string,
  ): Promise<{
    nodeId: string;
    question?: string;
    form?: Record<string, unknown>;
    status: string;
  } | null>;
  /** Terminalizes parked human tasks whose DSL `timeoutMs` has passed.
   *  Returns the execution ids it settled (the caller only logs them). */
  expireHumanTimeouts(now?: number): Promise<string[]>;
  recover(): Promise<void>;
}

function exitStatus(exit: string): "success" | "failure" | "custom" {
  if (exit === "failure") return "failure";
  if (exit === "success") return "success";
  return "custom";
}

class WorkflowCancelledError extends Error {
  constructor() {
    super("cancelled by user");
    this.name = "WorkflowCancelledError";
  }
}

function extractFinalText(outcome: unknown): string {
  const o = outcome as { messages?: Array<{ role?: string; text?: string }> } | null;
  const last = o?.messages
    ?.slice()
    .reverse()
    .find((m) => m.role === "assistant");
  return last?.text ?? "";
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  // Strip markdown code fences if present (deepseek often wraps JSON).
  const stripped = text
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```/g, "")
    .trim();
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function extractOutput(
  outcome: unknown,
  outputHint?: Record<string, string>,
): Record<string, unknown> {
  const text = extractFinalText(outcome);
  if (!text) return outputHint ? {} : { text: "" };
  const parsed = tryParseJsonObject(text);
  if (parsed) return parsed;
  if (outputHint)
    throw new Error("agent node output must be a JSON object matching declared output hints");
  return { text };
}

function buildAgentPrompt(
  node: WorkflowNode,
  input: Record<string, unknown>,
  outputHint?: Record<string, string>,
): string {
  const base = node.type === "agent" ? (node.prompt ?? "") : "";
  const schema = (node as { outputSchema?: unknown }).outputSchema;
  let suffix: string;
  if (schema && typeof schema === "object") {
    suffix = `\n\nYour final answer MUST be a single JSON object that conforms exactly to this JSON Schema:\n${JSON.stringify(schema)}\nRespond with ONLY the JSON object — no markdown fences, no commentary, no text before or after.`;
  } else if (outputHint && Object.keys(outputHint).length > 0) {
    suffix = `\n\nYour final answer MUST be a JSON object with fields: ${Object.keys(outputHint).join(", ")}\nRespond with ONLY the JSON object — no markdown fences, no commentary.`;
  } else {
    suffix = "";
  }
  return `${base}\n\nInput: ${JSON.stringify(input)}${suffix}`;
}

/** Map a human node's FormField form to the ask_question protocol. */
function formToAskQuestions(
  form: Record<string, unknown> | undefined,
  question: string | undefined,
): Array<Record<string, unknown>> {
  const questions: Array<Record<string, unknown>> = [];
  for (const [key, raw] of Object.entries(form ?? {})) {
    const f = raw as { type?: string; label?: string; options?: string[]; required?: boolean };
    const label = f.label ?? key;
    if (f.type === "enum") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: (f.options ?? []).map((v) => ({ value: v, label: v })),
        validation: { required: f.required !== false },
      });
    } else if (f.type === "boolean") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        validation: { required: f.required !== false },
      });
    } else {
      questions.push({
        id: key,
        kind: "text",
        question: label,
        header: question,
        multiline: f.type === "textarea",
        placeholder: f.label,
        validation: { required: f.required !== false },
      });
    }
  }
  if (questions.length === 0 && question) {
    questions.push({ id: "answer", kind: "text", question, multiline: true });
  }
  return questions;
}

export function createWorkflowExecutionService(
  deps: WorkflowExecutionServiceDeps,
): WorkflowExecutionService {
  const completions = new Map<string, CompletionRecord[]>();
  const cancelled = new Set<string>();
  function throwIfCancelled(executionId: string): void {
    if (cancelled.has(executionId)) throw new WorkflowCancelledError();
  }

  /** The durable trace is the only record now: a failure to write it must not block the drive. */
  function emit(executionId: string, event: string, data: unknown) {
    deps.port.appendExecutionEvent({ executionId, event, data, ts: Date.now() }).catch(() => {});
  }

  async function storeApiOf(
    executionId: string,
    getStore: () => Record<string, unknown>,
  ): Promise<StoreApi> {
    return {
      get: (key) => getStore()[key],
      set: async (key, value) => {
        const store = getStore();
        store[key] = value;
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, value });
      },
      delete: async (key) => {
        const store = getStore();
        delete store[key];
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, deleted: true });
      },
    };
  }

  /** Input/output hints arrive in two shapes in the wild: the DSL parser
   *  normalizes to [{key,type}], but legacy/showcase definitions and the
   *  HTTP route pass raw object-shaped `{key: type}` through JSON.parse.
   *  Accept both; never trust the static InputHint type at runtime. */
  function inputHintToRecord(hint: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(hint)) {
      for (const f of hint) {
        const row = f as { key?: unknown; type?: unknown };
        if (row && typeof row.key === "string") out[row.key] = String(row.type ?? "string");
      }
    } else if (hint && typeof hint === "object") {
      for (const [k, v] of Object.entries(hint as Record<string, unknown>)) {
        out[k] = typeof v === "string" ? v : "string";
      }
    }
    return out;
  }

  async function validateArtifactFields(
    schema: Record<string, unknown> | undefined,
    values: Record<string, unknown>,
    where: string,
  ): Promise<void> {
    if (!deps.artifactService || !schema) return;
    for (const [key, type] of Object.entries(schema)) {
      if (type !== "artifact") continue;
      const url = values[key];
      if (typeof url !== "string" || !url.startsWith("artifacts://")) continue;
      const ok = await deps.artifactService.exists(url);
      if (!ok) throw new Error(`${where} artifact ${key} does not exist: ${url}`);
    }
  }

  async function runNodeWithRetry(
    node: WorkflowNode,
    run: (n: WorkflowNode, lastError?: unknown) => Promise<NodeRunResult>,
  ): Promise<NodeRunResult> {
    const cfg = node.retry ?? 0;
    const maxRetries = typeof cfg === "number" ? cfg : (cfg.maxAttempts ?? 0);
    const intervalMs = typeof cfg === "number" ? 0 : (cfg.intervalMs ?? 0);
    const backoff = typeof cfg === "number" ? 1 : (cfg.backoff ?? 1);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await run(node, lastError);
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) throw err;
        // Active retry: wait with exponential backoff before re-running.
        const wait = intervalMs * backoff ** attempt;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }

  async function runWorkflowNode(
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    execution: WorkflowExecutionRow,
  ): Promise<Record<string, unknown>> {
    const runner = deps.nodeRunners.script;
    if (!runner) throw new Error(`no runner for node type ${node.type}`);
    const storeApi = await storeApiOf(execution.executionId, () => execution.store);
    const result = await runNodeWithRetry(node, (n) =>
      runner.run(n, {
        input: ready.input,
        store: storeApi,
        context: {
          executionId: execution.executionId,
          nodeId: n.id,
          workflowId: execution.workflowId,
        },
      }),
    );
    return result.output ?? {};
  }

  async function runAgentNode(
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    execution: WorkflowExecutionRow,
    lastError?: unknown,
  ): Promise<NodeRunResult> {
    if (node.type !== "agent") throw new Error(`not agent: ${node.type}`);
    if (
      !deps.agentRunService ||
      !deps.agentRunExecution ||
      !deps.convPort ||
      !deps.resolveDefaultModel ||
      !deps.conversationService
    ) {
      throw new Error(
        "agent runner requires agentRunService/agentRunExecution/convPort/conversationService/resolveDefaultModel",
      );
    }
    const inline = (node.agentId ?? "").trim() === "";
    // Inline agents (model+prompt, no system agentId) still need a real agent
    // member for the conversation identity (postMessage triggers through the
    // agent registry). Use the default agent as the member; the actual model
    // comes from node.model via modelOverride.
    const agentId = inline ? "default" : node.agentId!;
    if (!agentId) throw new Error("agent node requires agentId");
    // Repo-aware agent node (V1): repo must be an ATTACHED projectId with an
    // explicit agentId — never a URL, never a bare-mirror path. Binding the
    // conversation's projectId is what makes dispatch resolve the agent's
    // real worktree (resolveWorkspace); no workspace is pinned here.
    if (node.repo !== undefined) {
      if (inline) throw new Error("agent node with repo requires an explicit agentId");
      const attached = await deps.agentProjects?.(agentId);
      if (!attached?.includes(node.repo)) {
        throw new Error(
          `agent ${agentId} has not attached project ${node.repo}; attach it via the agent update API (runtime_config.projects)`,
        );
      }
    }
    const conversationId = `workflow:${execution.executionId}:${node.id}`;
    let prompt = buildAgentPrompt(node, ready.input, inputHintToRecord(node.output));
    if (lastError) {
      prompt += `\n\nYour previous attempt failed because:\n${lastError instanceof Error ? lastError.message : String(lastError)}\nCorrect the error and reply again with the required JSON only.`;
    }

    if (!deps.convPort.getConversation(conversationId)) {
      try {
        const conversation: Parameters<typeof deps.convPort.createConversation>[0] = {
          conversationId,
          agentId,
          origin: "workflow",
          createdAt: Date.now(),
        };
        if (node.repo !== undefined) conversation.projectId = node.repo;
        deps.convPort.createConversation(conversation);
      } catch {
        /* concurrent */
      }
    }

    const defaultModel = inline
      ? { backendKind: "oma", modelId: node.model ?? "" }
      : await deps.resolveDefaultModel(agentId);

    // Reconnect: if this node already has a persisted agent runId, poll that
    // run instead of triggering a new one. This survives workflow/agent
    // disconnects — the agent may have already completed.
    if (!deps.conversationService) throw new Error("agent runner requires conversationService");
    // Retry: clear the stale runId so this attempt starts a fresh run (the
    // previous attempt's output failed schema validation).
    if (lastError) {
      await deps.port.updateNodeRun(execution.executionId, node.id, { runId: null });
    }
    // The attempt in play is the node's latest row: an earlier attempt's runId
    // would reconnect this retry to a Run that already answered.
    const nodeRun = (await deps.port.listNodeRuns(execution.executionId))
      .filter((r) => r.nodeId === node.id)
      .at(-1);
    let runId: string | undefined | null = nodeRun?.runId;

    if (!runId) {
      const posted = await deps.conversationService.postMessage({
        conversationId,
        content: prompt,
        modelOverride: defaultModel,
        // A node conversation (workflow:<executionId>:<nodeId>) never appears
        // in the conversation list, so nothing can answer an approval prompt
        // raised here: asking would park the node forever. yolo is ungated and
        // still runs bash inside the OS sandbox.
        permissionMode: "yolo",
      });
      runId = posted.triggeredRuns[0]?.runId;
      if (!runId) throw new Error("agent run not triggered");
      await deps.port.updateNodeRun(execution.executionId, node.id, { runId });
      emit(execution.executionId, "node_agent_started", { nodeId: node.id, runId });
      await deps.agentRunExecution.dispatch(runId);
    }

    // Poll the run until terminal (reconnect-safe; no long-lived subscribe).
    // Success requires a CANONICAL completion: a commit_failed run may carry
    // a child outcome but its messages are not in the ledger yet, so it must
    // wait for recovery instead of pretending to be done. A waiting run
    // (HITL) is not progress either — its own ask timeout is the authority,
    // so the workflow clock pauses while it waits.
    const TIMEOUT_MS = deps.agentNodeTimeoutMs ?? 600_000;
    let deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfCancelled(execution.executionId);
      const run = await deps.agentRunService.getRun(runId);
      if (run?.status === "completed") {
        const output = extractOutput(run.terminalResult, inputHintToRecord(node.output));
        emit(execution.executionId, "node_agent_completed", { nodeId: node.id, runId });
        return { output };
      }
      if (run && ["failed", "aborted", "timeout"].includes(run.status ?? "")) {
        throw new Error(`agent run ${runId} ended ${run.status}`);
      }
      // running / waiting / commit_failed keep polling; waiting pauses the clock.
      if (run?.status === "waiting") deadline = Date.now() + TIMEOUT_MS;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Timeout: cancel the child first and wait for it to settle, then fail
    // the node — workflow must never keep a different answer than AgentRun
    // about whether this execution is alive (a bare throw could let a retry
    // start a second run beside a live child).
    await deps.agentRunExecution?.stop?.(runId).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const settled = await deps.agentRunService.getRun(runId);
      if (settled && ["completed", "failed", "aborted", "timeout"].includes(settled.status ?? ""))
        break;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`agent run ${runId} timed out after ${TIMEOUT_MS}ms`);
  }

  async function executeNode(
    execution: WorkflowExecutionRow,
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    order: number,
  ): Promise<{ output: Record<string, unknown> } | null> {
    emit(execution.executionId, "node_started", { nodeId: node.id, order });
    // One row per attempt (ADR 0042): a node whose latest row is terminal is
    // starting a NEW attempt and appends its own row; one that is running, or
    // parked on a gate, resumes the attempt it already has.
    const held = (await deps.port.listNodeRuns(execution.executionId))
      .filter((r) => r.nodeId === node.id)
      .at(-1);
    if (held === undefined || (held.status !== "running" && held.status !== "waiting_human")) {
      await deps.port.appendNodeRun({
        executionId: execution.executionId,
        nodeId: node.id,
        status: node.type === "human" ? "waiting_human" : "running",
        order,
      });
    }

    const inputErrors = node.inputSchema ? validateBySchema(ready.input, node.inputSchema) : [];
    if (inputErrors.length > 0)
      throw new Error(`node ${node.id} input invalid: ${inputErrors.join("; ")}`);
    await validateArtifactFields(
      inputHintToRecord(node.input),
      ready.input,
      `node ${node.id} input`,
    );

    let output: Record<string, unknown>;
    if (node.type === "start") {
      output = { ...execution.input };
      // Workflow-level required input artifacts must exist before running.
      await validateArtifactFields(
        inputHintToRecord(execution.definition.input),
        execution.input,
        `workflow ${execution.executionId} input`,
      );
    } else if (node.type === "human") {
      const question = (ready.input.question as string | undefined) ?? node.question;
      const form = (ready.input.form as Record<string, unknown> | undefined) ?? node.form;
      const questions = formToAskQuestions(form, question);
      await deps.port.createPendingHuman({
        executionId: execution.executionId,
        nodeId: node.id,
        question,
        form: { questions },
        status: "pending",
        createdAt: Date.now(),
      });
      await deps.port.updateExecution(execution.executionId, { status: "waiting_human" });
      emit(execution.executionId, "human_task_requested", { nodeId: node.id, question, questions });
      return null;
    } else {
      try {
        output =
          node.type === "agent"
            ? ((
                await runNodeWithRetry(node, async (n, lastError) => {
                  const r = await runAgentNode(n, ready, execution, lastError);
                  const output = r.output ?? {};
                  const errs = node.outputSchema ? validateBySchema(output, node.outputSchema) : [];
                  if (errs.length > 0)
                    throw new Error(`node ${node.id} output invalid: ${errs.join("; ")}`);
                  return r;
                })
              ).output ?? {})
            : await runWorkflowNode(node, ready, execution);
      } catch (err) {
        await deps.port.updateNodeRun(execution.executionId, node.id, {
          status: "failed",
          error: (err as Error).message,
          terminalAt: Date.now(),
        });
        emit(execution.executionId, "node_failed", {
          nodeId: node.id,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    const outputErrors = node.outputSchema ? validateBySchema(output, node.outputSchema) : [];
    if (outputErrors.length > 0)
      throw new Error(`node ${node.id} output invalid: ${outputErrors.join("; ")}`);
    await validateArtifactFields(inputHintToRecord(node.output), output, `node ${node.id} output`);
    return { output };
  }

  function recordCompletion(
    execution: WorkflowExecutionRow,
    node: WorkflowNode,
    output: Record<string, unknown>,
    order: number,
  ): CompletionRecord {
    const arr = completions.get(execution.executionId) ?? [];
    const routedTo = routeOutgoing(node.id, execution.definition, arr, execution.store, output);
    const record: CompletionRecord = { nodeId: node.id, output, order, routedTo };
    arr.push(record);
    completions.set(execution.executionId, arr);
    return record;
  }

  /** Apply a completed node's verdicts: every rework it asked for marks what it
   *  replaces as `superseded` — the rows stay as history, and because the retry
   *  is then owed to rows rather than to memory, a restart between the verdict
   *  and the retry owes nothing to luck (ADR 0042 §2.2). */
  async function applyRework(
    execution: WorkflowExecutionRow,
    from: string,
    output: Record<string, unknown> | undefined,
  ): Promise<void> {
    const nodeRuns = await deps.port.listNodeRuns(execution.executionId);
    const attempts: Record<string, number> = {};
    for (const run of nodeRuns) {
      // Gate rows are not attempts of the node they guard.
      if (budgetGateOf(run.output) !== undefined) continue;
      attempts[run.nodeId] = (attempts[run.nodeId] ?? 0) + 1;
    }
    const grants = planRework({
      def: execution.definition,
      from,
      sourceOutput: output,
      attempts,
      store: execution.store,
    });
    for (const grant of grants) {
      for (const nodeId of grant.invalidated) {
        // Nothing to invalidate where nothing was recorded (a node that never
        // ran); updateNodeRun returns null and that is not an error.
        await deps.port.updateNodeRun(execution.executionId, nodeId, { status: "superseded" });
      }
      emit(execution.executionId, "rework_requested", {
        from: grant.from,
        to: grant.to,
        attempt: grant.attempt,
        maxAttempts: grant.budget.maxAttempts,
        reason: grant.reason,
        invalidated: grant.invalidated,
      });
    }
  }

  /** A verdict the budget cannot pay for: end the execution, or park a gate
   *  that a human may resolve with `grant`. Idempotent — the drive loop runs
   *  this every iteration while the execution is not terminal. */
  async function applyExhausted(
    execution: WorkflowExecutionRow,
    grant: ReworkGrant,
    order: number,
  ): Promise<void> {
    const { budget, to } = grant;
    const detail = `rework budget for "${to}" is spent after ${budget.maxAttempts} attempt(s); last verdict: ${grant.reason}`;
    if (budget.onExhausted === "fail") {
      emit(execution.executionId, "budget_exhausted", { ...grantContext(grant), action: "fail" });
      throw new Error(detail);
    }
    const gateNodeId = budgetGateNodeId(to);
    const pending = await deps.port.getPendingHuman(execution.executionId, gateNodeId);
    if (pending?.status === "pending") return; // already parked
    const gate: BudgetGateRecord = {
      nodeId: to,
      from: grant.from,
      attempt: grant.attempt,
      maxAttempts: budget.maxAttempts,
      reason: grant.reason,
    };
    await deps.port.appendNodeRun({
      executionId: execution.executionId,
      nodeId: gateNodeId,
      status: "waiting_human",
      order,
      output: { budgetGate: gate },
    });
    await deps.port.createPendingHuman({
      executionId: execution.executionId,
      nodeId: gateNodeId,
      question: `Node "${to}" used up its rework budget (${budget.maxAttempts} attempt(s)). Grant one more attempt? Last verdict: ${grant.reason}`,
      form: { budgetGate: gate },
      status: "pending",
      createdAt: Date.now(),
    });
    await deps.port.updateExecution(execution.executionId, { status: "waiting_human" });
    emit(execution.executionId, "budget_exhausted", {
      ...grantContext(grant),
      action: "human",
      gateNodeId,
    });
    emit(execution.executionId, "human_task_requested", {
      nodeId: gateNodeId,
      question: `grant another attempt to "${to}"?`,
      budgetGate: gate,
    });
  }

  function grantContext(grant: ReworkGrant): Record<string, unknown> {
    return {
      from: grant.from,
      to: grant.to,
      attempt: grant.attempt,
      maxAttempts: grant.budget.maxAttempts,
      reason: grant.reason,
    };
  }

  function rebuildCompletions(nodeRuns: WorkflowNodeRunRow[]): CompletionRecord[] {
    return nodeRuns
      .filter((r) => r.status === "completed")
      .map((r, i) => ({
        nodeId: r.nodeId,
        output: r.output ?? {},
        order: i,
        routedTo: r.routedTo ?? [],
      }));
  }

  async function drive(execution: WorkflowExecutionRow): Promise<void> {
    if (completions.get(execution.executionId) === undefined) {
      const nodeRuns = await deps.port.listNodeRuns(execution.executionId);
      completions.set(execution.executionId, rebuildCompletions(nodeRuns));
    }
    let order = completions.get(execution.executionId)!.length;
    for (;;) {
      throwIfCancelled(execution.executionId);
      // The rework state is derived from the rows, so it survives a restart,
      // a crash or a second process: what is superseded owes a retry, and a
      // verdict the budget cannot pay for is the one thing left to apply.
      const derived = deriveRework(
        execution.definition,
        await deps.port.listNodeRuns(execution.executionId),
      );
      const exhausted = derived.exhausted[0];
      if (exhausted) {
        await applyExhausted(execution, exhausted, order);
        if (exhausted.budget.onExhausted === "human") return; // parked
      }
      const state: EngineState = {
        completions: completions.get(execution.executionId) ?? [],
        store: execution.store,
        trigger: execution.input,
        invalidated: derived.invalidated,
        rework: derived.grants,
      };
      const step = computeNext(execution.definition, state);
      if (step.kind === "terminal") {
        await deps.port.updateExecution(execution.executionId, {
          status: exitStatus(step.exit),
          exit: step.exit,
          terminalAt: Date.now(),
        });
        emit(execution.executionId, "execution_terminal", { exit: step.exit });
        return;
      }
      if (step.kind === "idle") throw new Error("stuck: no ready nodes and no terminal");
      let paused = false;
      for (const ready of step.ready) {
        const node = ready.node;
        const res = await executeNode(execution, node, ready, order++);
        if (res === null) {
          paused = true;
          break;
        }
        const record = recordCompletion(execution, node, res.output, order - 1);
        await deps.port.updateNodeRun(execution.executionId, node.id, {
          status: "completed",
          output: record.output,
          routedTo: record.routedTo,
          terminalAt: Date.now(),
        });
        emit(execution.executionId, "node_completed", {
          nodeId: node.id,
          output: record.output,
          routedTo: record.routedTo,
        });
        // The verdict this completion carries (ADR 0042 §2): a rework edge whose
        // condition holds now invalidates what it replaces.
        await applyRework(execution, node.id, record.output);
        const fresh = await deps.port.getExecution(execution.executionId);
        if (fresh) execution.store = fresh.store;
      }
      if (paused) return;
    }
  }

  async function runWithCatch(executionId: string, execute: () => Promise<void>): Promise<void> {
    try {
      await execute();
    } catch (err) {
      if (err instanceof WorkflowCancelledError) cancelled.delete(executionId);
      await deps.port.updateExecution(executionId, {
        status: "failure",
        error: (err as Error).message,
        exit: "failure",
        terminalAt: Date.now(),
      });
      emit(executionId, "execution_terminal", { exit: "failure", error: (err as Error).message });
    }
  }

  return {
    async runToCompletion(executionId, input) {
      const row = await deps.port.createExecution({
        executionId,
        workflowId: input.workflowId,
        definition: input.definition,
        input: input.input,
        store: {},
        status: "running",
        triggeredBy: input.triggeredBy ?? "manual",
      });
      emit(executionId, "execution_started", {});
      await runWithCatch(executionId, () => drive(row));
      return (await deps.port.getExecution(executionId))!;
    },
    async startExecution(input) {
      // Single-flight by DB truth, not memory: a manual trigger must not open a
      // second concurrent execution of the same workflow (measured live: two
      // solvers raced the same issue because the manual path bypassed the
      // scheduler's in-memory set). Cron fires get the same answer here.
      const active = (await deps.port.listExecutions(input.workflowId)).find(
        (e) => e.status === "running",
      );
      if (active) {
        throw new HttpError(
          `workflow ${input.workflowId} already has a running execution (${active.executionId}); wait, or cancel it first`,
          409,
        );
      }
      const executionId = deps.idGen();
      const row = await deps.port.createExecution({
        executionId,
        workflowId: input.workflowId,
        definition: input.definition,
        input: input.input,
        store: {},
        status: "running",
        triggeredBy: input.triggeredBy ?? "manual",
      });
      emit(executionId, "execution_started", {});
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async resolveHumanTasks(
      decisions: Array<{
        executionId: string;
        nodeId: string;
        answer?: Record<string, unknown>;
      }>,
    ): Promise<Array<{ executionId: string; ok: boolean; error?: string }>> {
      const results: Array<{ executionId: string; ok: boolean; error?: string }> = [];
      for (const d of decisions) {
        try {
          await this.resolveHumanTask(d.executionId, d.nodeId, d.answer ?? {});
          results.push({ executionId: d.executionId, ok: true });
        } catch (err) {
          results.push({
            executionId: d.executionId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    },

    async resolveHumanTask(executionId, nodeId, answer) {
      const row = await deps.port.getExecution(executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      if (row.status !== "waiting_human")
        throw new HttpError("Execution is not waiting for human", 409);
      const pending = await deps.port.getPendingHuman(executionId, nodeId);
      if (!pending) throw new HttpError("Pending human task not found", 404);
      if (pending.status === "resolved") throw new HttpError("Human task already resolved", 409);

      // A budget gate is not a form: its answer is `{decision: "grant"|"reject"}`
      // (ADR 0042 §2.4) — grant buys the attempt the budget refused, reject ends
      // the execution.
      const gate = budgetGateOf(pending.form);
      if (gate) {
        const decision = answer.decision;
        if (decision !== "grant" && decision !== "reject") {
          throw new HttpError('budget gate answer must be {decision:"grant"|"reject"}', 400);
        }
        const gateClaimed = await deps.port.markPendingHumanResolved(executionId, nodeId);
        if (!gateClaimed) throw new HttpError("Human task already resolved", 409);
        await deps.port.updateNodeRun(executionId, nodeId, {
          status: "superseded",
          output: { budgetGate: gate, decision },
          terminalAt: Date.now(),
        });
        if (decision === "reject") {
          const error = `rework budget for "${gate.nodeId}" was rejected: ${gate.reason}`;
          await deps.port.updateExecution(executionId, {
            status: "failure",
            exit: "failure",
            error,
            terminalAt: Date.now(),
          });
          emit(executionId, "execution_terminal", { exit: "failure", error });
          return (await deps.port.getExecution(executionId))!;
        }
        await deps.port.updateExecution(executionId, { status: "running" });
        void runWithCatch(executionId, () => drive(row));
        return row;
      }

      // The answer arrives over HTTP and must stay DATA (M1): `nextNode`
      // would override every `when` condition downstream, and the
      // prototype-pollution keys are control plane. Same filter as
      // mergeInputs' data plane.
      const answerData = Object.fromEntries(
        Object.entries(answer).filter(
          ([k]) =>
            k !== "nextNode" && k !== "__proto__" && k !== "constructor" && k !== "prototype",
        ),
      );

      const done = (await deps.port.listNodeRuns(executionId)).filter(
        (r) => r.status === "completed",
      );
      const arr = done.map((r, i) => ({
        nodeId: r.nodeId,
        output: r.output ?? {},
        order: i,
        routedTo: r.routedTo ?? [],
      }));
      const routedTo = routeOutgoing(nodeId, row.definition, arr, row.store, answerData);
      const claimed = await deps.port.markPendingHumanResolved(executionId, nodeId);
      if (!claimed) throw new HttpError("Human task already resolved", 409);
      await deps.port.updateNodeRun(executionId, nodeId, {
        status: "completed",
        output: answerData,
        routedTo,
        terminalAt: Date.now(),
      });
      // A human's verdict is a verdict like any other: it must be able to send
      // work back. This path does not pass through the drive loop's completion
      // block, so the rework is planned here too (found live: a "redo" answer
      // recorded, routed to the next node, and never reworked).
      await applyRework(row, nodeId, answerData);
      arr.push({ nodeId, output: answerData, order: arr.length, routedTo });
      completions.set(executionId, arr);
      const fresh = await deps.port.getExecution(executionId);
      if (fresh) row.store = fresh.store;
      await deps.port.updateExecution(executionId, { status: "running" });
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async getExecution(id) {
      return deps.port.getExecution(id);
    },
    async listNodeRuns(id) {
      return deps.port.listNodeRuns(id);
    },
    async listExecutions(workflowId) {
      return deps.port.listExecutions(workflowId);
    },
    async deleteExecution(executionId: string) {
      return deps.port.deleteExecution(executionId);
    },
    async cancelExecution(executionId: string) {
      const row = await deps.port.getExecution(executionId);
      if (!row || !["running", "waiting_human"].includes(row.status)) return row;
      cancelled.add(executionId);
      // waiting_human has no live drive loop to unwind — terminalize directly.
      if (row.status === "waiting_human") {
        await deps.port.updateExecution(executionId, {
          status: "failure",
          exit: "aborted",
          error: "cancelled by user",
          terminalAt: Date.now(),
        });
        cancelled.delete(executionId);
        emit(executionId, "execution_terminal", { exit: "aborted", error: "cancelled by user" });
        return await deps.port.getExecution(executionId);
      }
      // running: the drive/poll loops observe the flag and unwind; mark now
      // so API consumers see intent immediately.
      return row;
    },
    async listExecutionEvents(executionId) {
      return deps.port.listExecutionEvents(executionId);
    },
    async getPendingHuman(executionId, nodeId) {
      return deps.port.getPendingHuman(executionId, nodeId);
    },
    /** A parked human task has no live loop, so `timeoutMs` used to be a
     *  promise the DSL made and nothing kept. The pending row's `createdAt` is
     *  the clock (no new column) and the same atomic claim as an answer decides
     *  the race: whoever loses `markPendingHumanResolved` does nothing. */
    async expireHumanTimeouts(now = Date.now()) {
      const expired: string[] = [];
      for (const execution of await deps.port.listWaitingHumanExecutions()) {
        if (execution.status !== "waiting_human") continue;
        const waiting = (await deps.port.listNodeRuns(execution.executionId))
          .filter((r) => r.status === "waiting_human")
          .at(-1);
        if (!waiting) continue;
        // A rework budget gate parks under a synthetic id (`<node>#budget`)
        // that no DSL node answers to — it declares no timeout, so it is
        // skipped rather than treated as an unknown node.
        const node = execution.definition.nodes.find((n) => n.id === waiting.nodeId);
        if (node?.type !== "human" || !node.timeoutMs) continue;
        const pending = await deps.port.getPendingHuman(execution.executionId, waiting.nodeId);
        if (!pending) continue;
        if (pending.status !== "pending") continue;
        if (now - pending.createdAt < node.timeoutMs) continue;

        if (!(await deps.port.markPendingHumanResolved(execution.executionId, waiting.nodeId))) {
          continue; // an answer claimed it first; that path owns the outcome
        }
        const error = `human task "${waiting.nodeId}" timed out after ${node.timeoutMs}ms`;
        await deps.port.updateNodeRun(execution.executionId, waiting.nodeId, {
          status: "failed",
          error,
          terminalAt: now,
        });
        await deps.port.updateExecution(execution.executionId, {
          status: "failure",
          exit: "failure",
          error,
          terminalAt: now,
        });
        emit(execution.executionId, "node_failed", { nodeId: waiting.nodeId, error });
        emit(execution.executionId, "execution_terminal", { exit: "failure", error });
        expired.push(execution.executionId);
      }
      return expired;
    },
    async recover() {
      for (const e of await deps.port.listRunningExecutions()) {
        void runWithCatch(e.executionId, () => drive(e));
      }
    },
  };
}
