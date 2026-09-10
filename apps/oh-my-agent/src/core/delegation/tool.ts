import type { PluginTool } from "../index.js";
import type { SubagentBatchResult, SubagentResult, SubagentSpec } from "./executor.js";
import { builtinAgentNames, resolveAgent } from "./roles.js";

export {
  type AgentRole,
  isValidWorkflowName,
  parseAgentDefinition,
} from "./roles.js";

export interface DelegationToolDeps {
  readonly runBatch: (input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  }) => Promise<SubagentBatchResult>;
  /** 3.4: dispatch ONE named subagent (batchId/agentId are minted by the
   *  wiring closure). `signal` is the calling loop's abort signal. */
  readonly runSubagent: (spec: SubagentSpec, signal?: AbortSignal) => Promise<SubagentResult>;
  /** 3.4: raw markdown of `<workspace>/.oma/agents/<name>.md`, or null when
   *  absent. The name is already validated before this is called. */
  readonly readAgentDefinition: (name: string) => Promise<string | null>;
}

/** The model-facing delegation surface: one fan-out tool (batch + single).
 *  Control (poll/wait/steer/stop) lives in the coordination hub tool; script
 *  orchestration lives in orchestrate/tool.ts. */
export function createDelegationTools(deps: DelegationToolDeps): readonly PluginTool[] {
  const MAX_BATCH_TASKS = 64;
  const task: PluginTool = {
    name: "task",
    description:
      "Fan out subagents. BATCH (preferred): {context, tasks:[{name?, agent?, task, outputSchema?}]} — " +
      "context is shared background injected into every spawn; items run under the executor " +
      "semaphore; long results spill to .oma/workflow with a resultPath. Roles: task (full tools), " +
      "explore (read-only), plan (read-only planning), or any .oma/agents/<name>.md definition. " +
      "SINGLE (compat): {agent, prompt, schema?, background?, resume?} — background:true returns a " +
      "handle immediately (poll/wait/steer via hub); {resume, prompt} continues the SAME subagent.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "BATCH: shared background injected into every spawn's prompt (required with tasks)",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "BATCH: one subagent per item",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Stable label for the handle/result" },
              agent: { type: "string", description: "Role (default task)" },
              task: { type: "string", description: "Self-contained instructions" },
              outputSchema: { type: "object", description: "JSON schema for the final answer" },
            },
            required: ["task"],
          },
        },
        agent: { type: "string" },
        prompt: { type: "string" },
        schema: { type: "object" },
        resume: { type: "string" },
        background: { type: "boolean" },
      },
      // BATCH: context + tasks required; runtime enforces. SINGLE (compat):
      // agent XOR resume (with prompt required either way); runtime enforces.
    },
    async execute(args, signal) {
      const agent = typeof args.agent === "string" ? args.agent.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const resume = typeof args.resume === "string" ? args.resume.trim() : "";

      // Batch fan-out (pi task.batch shape): required shared context +
      // per-item spawns under the executor semaphore. The executor owns
      // spill, budget/cap gating, abort-on-failure, and the
      // delegation_batch_* event stream. Flat single-spawn params stay
      // accepted (pi runtime is permissive across shapes).
      if (Array.isArray(args.tasks)) {
        const context = typeof args.context === "string" ? args.context.trim() : "";
        if (!context) {
          return {
            ok: false,
            error: "context is required for batch calls (shared background for every spawn)",
          };
        }
        const items = args.tasks as Array<Record<string, unknown>>;
        if (items.length === 0) return { ok: false, error: "tasks must be a non-empty array" };
        if (items.length > MAX_BATCH_TASKS) {
          return { ok: false, error: `too many tasks (${items.length}; max ${MAX_BATCH_TASKS})` };
        }
        const seen = new Set<string>();
        for (const item of items) {
          if (typeof item.task !== "string" || item.task.trim() === "") {
            return { ok: false, error: "each task item needs a non-empty task" };
          }
          if (typeof item.name === "string" && item.name.trim() !== "") {
            const key = item.name.trim().toLowerCase();
            if (seen.has(key)) {
              return { ok: false, error: `duplicate task name "${item.name.trim()}"` };
            }
            seen.add(key);
          }
        }
        // Resolve roles upfront: one unknown role fails the whole call
        // before any spawn (pi-aligned validation shape).
        const metas: Array<{
          label: string;
          agent: string;
          task: string;
          schema?: Readonly<Record<string, unknown>>;
          systemPrompt: string;
          tools?: readonly string[];
          modelId?: string;
        }> = [];
        for (const item of items) {
          const agent =
            typeof item.agent === "string" && item.agent.trim() !== "" ? item.agent.trim() : "task";
          const def = await resolveAgent(agent, deps.readAgentDefinition);
          if (!def) {
            return {
              ok: false,
              error: `unknown subagent "${agent}" (builtin: ${builtinAgentNames().join(", ")}; or .oma/agents/<name>.md)`,
            };
          }
          metas.push({
            label:
              typeof item.name === "string" && item.name.trim() !== ""
                ? item.name.trim()
                : `${agent}-${metas.length + 1}`,
            agent,
            task: item.task as string,
            schema:
              typeof item.outputSchema === "object" &&
              item.outputSchema !== null &&
              !Array.isArray(item.outputSchema)
                ? (item.outputSchema as Readonly<Record<string, unknown>>)
                : undefined,
            systemPrompt: def.systemPrompt,
            tools: def.tools,
            modelId: def.modelId,
          });
        }
        const batch = await deps.runBatch({
          batchId: `task-${crypto.randomUUID()}`,
          label: "task",
          items: metas.map((meta) => ({
            prompt: `${context}\n\n---\n\n${meta.task}`,
            label: meta.label,
            ...(meta.schema ? { schema: meta.schema } : {}),
            systemPrompt: meta.systemPrompt,
            ...(meta.tools ? { toolNames: meta.tools } : {}),
            ...(meta.modelId ? { modelId: meta.modelId } : {}),
          })),
          ...(signal ? { signal } : {}),
        });
        const results = batch.items.map((r, i) => ({
          index: i + 1,
          name: r.label,
          agent: metas[i]!.agent,
          ok: r.ok,
          text: r.text,
          ...(r.output !== undefined ? { output: r.output } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(r.usage ? { usage: r.usage } : {}),
          ...(r.handle ? { handle: r.handle } : {}),
          ...(r.resultPath ? { resultPath: r.resultPath } : {}),
        }));
        const lines = results.map(
          (r, i) =>
            `${i + 1}. ${r.name} (${r.agent}) — ${r.ok ? "ok" : "error"}\n${String(r.text ?? r.error ?? "")}`,
        );
        return { ok: batch.ok, content: lines.join("\n\n"), results };
      }
      if (!prompt) return { ok: false, error: "prompt is required" };
      if (resume) {
        const result = await deps.runSubagent(
          { prompt, ...(agent ? { label: agent } : {}), resumeHandle: resume },
          signal,
        );
        return { label: result.label, text: result.text, ok: result.ok };
      }
      if (!agent) return { ok: false, error: "agent (or resume handle) and prompt are required" };
      const def = await resolveAgent(agent, deps.readAgentDefinition);
      if (!def) {
        const builtin = builtinAgentNames().join(", ");
        return {
          ok: false,
          error: `unknown subagent "${agent}" (builtin: ${builtin}; or .oma/agents/<name>.md)`,
        };
      }
      const schema = args.schema;
      const result = await deps.runSubagent(
        {
          prompt,
          label: agent,
          ...(schema && typeof schema === "object" && !Array.isArray(schema)
            ? { schema: schema as Readonly<Record<string, unknown>> }
            : {}),
          systemPrompt: def.systemPrompt,
          ...(def.tools ? { toolNames: def.tools } : {}),
          ...(def.modelId ? { modelId: def.modelId } : {}),
          ...(args.background === true ? { background: true } : {}),
        },
        signal,
      );
      return {
        label: result.label,
        text: result.text,
        ok: result.ok,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.handle ? { handle: result.handle } : {}),
        ...(result.status ? { status: result.status } : {}),
      };
    },
  };

  return [task];
}
