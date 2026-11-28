import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHubTool } from "../coordination/index.js";
import type { CoordinationRegistry } from "../coordination/registry.js";
import { createDelegationExecutor, type SubagentResult } from "../delegation/executor.js";
import { builtinAgentNames, resolveAgent } from "../delegation/roles.js";
import { createDelegationTools, isValidWorkflowName } from "../delegation/tool.js";
import type {
  ContextBudget,
  ContextSummarizer,
  OmaLoopEvent,
  Plugin,
  PluginTool,
} from "../index.js";
import { evaluateOrchestrationScript } from "../orchestrate/script-runner.js";
import { createOrchestrateTool, type OrchestrationScriptResult } from "../orchestrate/tool.js";
import { pathPolicyRefusal, planModeRefusal, WorkspaceSandbox } from "../tools/index.js";
import type { BackgroundSupervision } from "./agent-loop-types.js";
import type { Usage } from "./contract/index.js";
import type { RunModelStream, SessionPermissionGate } from "./run-permissions.js";
import type { RunRuntimeDeps } from "./run-runtime.js";
import { toolFilterAllows } from "./tool-filter.js";

/** Read-only deterministic workspace tools exposed to orchestration scripts via
 *  `tool(name, input)`. Writes and shell execution must go through `agent()`. */
export const ORCHESTRATE_READ_TOOLS: ReadonlySet<string> = new Set([
  "glob",
  "grep",
  "read",
  "ls",
  "tree",
]);

function aggregateUsage(results: readonly SubagentResult[]): {
  usage: Usage;
  totalTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const r of results) {
    inputTokens += r.usage?.inputTokens ?? 0;
    outputTokens += r.usage?.outputTokens ?? 0;
    cacheReadTokens += r.usage?.cacheReadTokens ?? 0;
    cacheWriteTokens += r.usage?.cacheWriteTokens ?? 0;
  }
  const usage: Usage = {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
  return {
    usage,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** Delegation/orchestration stack: the subagent executor, the isolated script
 *  runner, and the three surface plugins (delegation / orchestrate / hub). */
export function createDelegationStack(
  deps: RunRuntimeDeps,
  ctx: {
    registry: CoordinationRegistry;
    scope: string;
    agentTools: readonly PluginTool[];
    summarize: ContextSummarizer;
    contextBudget: ContextBudget;
    makeSessionPermissionGate?: (intentTexts: readonly string[]) => SessionPermissionGate;
    streamModel: RunModelStream;
    budgetGate: () => { allowed: boolean; reason?: string };
    emit: (event: OmaLoopEvent) => void;
  },
): {
  delegationExecutor: ReturnType<typeof createDelegationExecutor>;
  runScript: (input: {
    script: string;
    args?: unknown;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<OrchestrationScriptResult>;
  plugins: Plugin[];
  backgroundSupervision: BackgroundSupervision;
} {
  const { registry, scope, agentTools, summarize, contextBudget, streamModel, budgetGate, emit } =
    ctx;
  const { makeSessionPermissionGate } = ctx;
  const subagentTools = deps.toolFilter
    ? agentTools.filter((t) => toolFilterAllows(deps.toolFilter!, t.name))
    : agentTools;
  const subagentToolByName = new Map(subagentTools.map((t) => [t.name, t]));

  const readAgentDefinition = async (name: string): Promise<string | null> => {
    if (!isValidWorkflowName(name)) return null;
    if (deps.workspaceAccess !== "read_write") return null;
    try {
      return await Bun.file(join(deps.workspaceRoot, ".oma", "agents", `${name}.md`)).text();
    } catch {
      return null;
    }
  };

  const delegationExecutor = createDelegationExecutor({
    registry,
    makeSubagentStream:
      (_sessionId, modelIdOverride, responseFormat) => (messages, signal, tools) =>
        streamModel(messages, signal, tools, modelIdOverride, responseFormat),
    modelId: deps.modelId,
    summarize,
    contextBudget,
    tools: subagentTools,
    workspaceRoot: deps.workspaceRoot,
    workspaceAccess: deps.workspaceAccess,
    scope,
    budgetGate,
    ...(makeSessionPermissionGate ? { makePermissionGate: makeSessionPermissionGate } : {}),
    emit: (event) => {
      emit(event);
    },
    maxConcurrent: 8,
    maxTotal: 64,
  });

  const runScript = async ({
    script,
    args,
    label,
    timeoutMs,
    signal,
  }: {
    script: string;
    args?: unknown;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<OrchestrationScriptResult> => {
    const batchId = `orch-${crypto.randomUUID()}`;
    const results: SubagentResult[] = [];
    const scriptController = new AbortController();
    const onExternalAbort = (): void => scriptController.abort();
    if (signal?.aborted) {
      scriptController.abort();
    } else {
      signal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    emit({
      type: "delegation_batch_started",
      batchId,
      label: label ?? "orchestrate",
      source: "workflow",
      agentCount: 0,
    });
    let value: unknown;
    let logs: readonly string[];
    let failed = false;
    try {
      const evaluated = await evaluateOrchestrationScript({
        script,
        args,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        signal: scriptController.signal,
        primitives: {
          agent: async (prompt, opts) => {
            const roleName = (opts?.role ?? opts?.agent)?.trim();
            let roleSystemPrompt: string | undefined;
            let roleTools: readonly string[] | undefined;
            let roleModelId: string | undefined;
            if (roleName) {
              const def = await resolveAgent(roleName, readAgentDefinition);
              if (!def) {
                throw new Error(
                  `unknown subagent role "${roleName}" (builtin: ${builtinAgentNames().join(", ")}; or .oma/agents/<name>.md)`,
                );
              }
              roleSystemPrompt = def.systemPrompt;
              roleTools = def.tools;
              roleModelId = def.modelId;
            }
            let effectiveToolNames = roleTools;
            if (Array.isArray(opts?.tools)) {
              const requested = opts.tools.filter((t): t is string => typeof t === "string");
              effectiveToolNames = roleTools
                ? requested.filter((t) => roleTools!.includes(t))
                : requested;
            }
            const modelId =
              typeof opts?.model === "string" && opts.model.trim()
                ? opts.model.trim()
                : roleModelId;
            const agentTimeoutMs =
              typeof opts?.timeoutMs === "number" &&
              Number.isFinite(opts.timeoutMs) &&
              opts.timeoutMs > 0
                ? Math.floor(opts.timeoutMs)
                : undefined;
            const agentSignal =
              agentTimeoutMs !== undefined
                ? AbortSignal.any([scriptController.signal, AbortSignal.timeout(agentTimeoutMs)])
                : scriptController.signal;

            const result = await delegationExecutor.runSubagent(
              {
                batchId,
                agentId: randomUUID(),
                prompt,
                ...(opts?.schema ? { schema: opts.schema } : {}),
                ...(opts?.label ? { label: opts.label } : roleName ? { label: roleName } : {}),
                ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
                ...(effectiveToolNames ? { toolNames: effectiveToolNames } : {}),
                ...(modelId ? { modelId } : {}),
              },
              agentSignal,
            );
            results.push(result);
            return result;
          },
          tool: async (name, toolInput) => {
            if (!ORCHESTRATE_READ_TOOLS.has(name)) {
              throw new Error(
                `tool "${name}" is not allowed in orchestration scripts (allowed read-only tools: ${[...ORCHESTRATE_READ_TOOLS].join(", ")}; use agent() for writes or bash)`,
              );
            }
            const target = subagentToolByName.get(name);
            if (!target) {
              throw new Error(`tool "${name}" is not available in this run`);
            }
            return await target.execute(toolInput, scriptController.signal);
          },
          onPhase: (p) => {
            emit({
              type: "delegation_phase",
              batchId,
              phase: p.name,
              status: p.status,
              ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
            });
          },
        },
      });
      value = evaluated.value;
      logs = evaluated.logs;
    } catch (err) {
      failed = true;
      scriptController.abort();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
      const { totalTokens } = aggregateUsage(results);
      const ok = !failed && results.every((r) => r.ok);
      emit({
        type: "delegation_batch_completed",
        batchId,
        ok,
        agentCount: results.length,
        totalTokens,
      });
    }
    const { usage, totalTokens } = aggregateUsage(results);
    const ok = results.every((r) => r.ok);
    return { ok, totalTokens, usage, value, logs };
  };

  const delegationTools = createDelegationTools({
    runBatch: (input) => delegationExecutor.runBatch(input),
    runSubagent: (spec, signal) =>
      delegationExecutor.runSubagent(
        {
          ...spec,
          batchId: `sub-${crypto.randomUUID()}`,
          agentId: spec.label ?? "sub",
        },
        signal,
      ),
    readAgentDefinition,
  });

  const orchestrateTools = createOrchestrateTool({
    runScript,
    writeScript: (name, content) => {
      if (!isValidWorkflowName(name)) {
        throw new Error(`invalid orchestration name (allowed: [a-z0-9-], max 64): ${name}`);
      }
      if (deps.workspaceAccess !== "read_write") {
        throw new Error("orchestration scripts cannot be saved in a read_only workspace");
      }
      const targetPath = new WorkspaceSandbox(deps.workspaceRoot).validateNew(
        join(".oma", "orchestrations", `${name}.js`),
      );
      const planBlocked = planModeRefusal(deps.planMode, targetPath);
      if (planBlocked) throw new Error(planBlocked);
      const policyBlocked = pathPolicyRefusal(targetPath);
      if (policyBlocked) throw new Error(policyBlocked);
      const dir = join(deps.workspaceRoot, ".oma", "orchestrations");
      mkdirSync(dir, { recursive: true });
      writeFileSync(targetPath, content);
    },
    readScript: async (name) => {
      if (!isValidWorkflowName(name)) return null;
      for (const folder of ["orchestrations", "workflow"]) {
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma", folder, `${name}.js`)).text();
        } catch {
          /* try next location */
        }
      }
      return null;
    },
  });

  const pendingInput = { has: (): boolean => false };
  const hubTools = createHubTool({
    scope,
    list: (s) => registry.listEntries(s),
    get: (id) => registry.getEntry(id),
    wait: (o) =>
      registry.waitInterruptible({
        ids: o.ids,
        scope: o.scope,
        totalMs: o.timeoutMs,
        shouldWake: o.shouldWake,
      }),
    hasPendingInput: () => pendingInput.has(),
    acknowledge: (ids) => registry.acknowledgeDeliveries(ids),
    isDelivered: (id) => registry.isDeliveryAcknowledged(id),
    stop: (id) => {
      const e = registry.getEntry(id);
      if (e?.kind === "subagent") return delegationExecutor.stopSubagent(id);
      return registry.stopEntry(id);
    },
    steer: (handle, prompt) => {
      const e = registry.getEntry(handle);
      if (e && e.kind !== "subagent") {
        return {
          ok: false,
          error: `"${handle}" is a ${e.kind} job; only subagent handles can be steered`,
        };
      }
      return delegationExecutor.steerSubagent(handle, prompt);
    },
  });

  return {
    delegationExecutor,
    runScript,
    plugins: [
      { name: "delegation-tools", tools: delegationTools },
      ...(deps.workspaceAccess === "read_write" && !deps.planMode
        ? [{ name: "orchestrate-tool", tools: orchestrateTools }]
        : []),
      { name: "hub-tool", tools: hubTools },
    ],
    backgroundSupervision: {
      countRunning: () => registry.countRunningJobs(scope),
      waitInterruptible: async (o: {
        totalMs: number;
        sliceMs?: number;
        shouldWake?: () => boolean;
      }) => {
        const res = await registry.waitInterruptible({
          scope,
          totalMs: o.totalMs,
          sliceMs: o.sliceMs,
          shouldWake: o.shouldWake,
        });
        const settled = res.settled.map((r) => {
          const e = registry.getEntry(r.id);
          const full =
            e?.output ?? (typeof e?.result?.text === "string" ? e.result.text : "") ?? "";
          const flat = full.replace(/\s+/g, " ").trim();
          return {
            id: r.id,
            kind: r.kind,
            status: r.status,
            label: r.label,
            summary: flat === "" ? "" : flat.slice(-300),
          };
        });
        return { settled, timedOut: res.timedOut, woke: res.woke };
      },
      acknowledge: (ids: readonly string[]) => registry.acknowledgeDeliveries(ids),
      cancelAll: async () => {
        const running = registry.listEntries(scope).filter((e) => e.status === "running");
        const labels: string[] = [];
        for (const entry of running) {
          if (entry.kind === "subagent") {
            delegationExecutor.stopSubagent(entry.id);
          } else {
            registry.stopEntry(entry.id);
          }
          labels.push(entry.label);
        }
        return labels;
      },
      pendingInput,
    },
  };
}
