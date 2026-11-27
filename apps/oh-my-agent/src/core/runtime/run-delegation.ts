import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHubTool } from "../coordination/index.js";
import type { CoordinationRegistry } from "../coordination/registry.js";
import { createDelegationExecutor, type SubagentResult } from "../delegation/executor.js";
import { createDelegationTools, isValidWorkflowName } from "../delegation/tool.js";
import type {
  ContextBudget,
  ContextSummarizer,
  OmaLoopEvent,
  Plugin,
  PluginTool,
} from "../index.js";
import { evaluateOrchestrationScript } from "../orchestrate/script-runner.js";
import { createOrchestrateTool } from "../orchestrate/tool.js";
import { pathPolicyRefusal, planModeRefusal, WorkspaceSandbox } from "../tools/index.js";
import type { BackgroundSupervision } from "./agent-loop-types.js";
import type { RunModelStream, SessionPermissionGate } from "./run-permissions.js";
import type { RunRuntimeDeps } from "./run-runtime.js";
import { toolFilterAllows } from "./tool-filter.js";

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
  runScript: (input: { script: string; args?: unknown }) => Promise<{
    ok: boolean;
    totalTokens: number;
    value: unknown;
  }>;
  plugins: Plugin[];
  backgroundSupervision: BackgroundSupervision;
} {
  const { registry, scope, agentTools, summarize, contextBudget, streamModel, budgetGate, emit } =
    ctx;
  const { makeSessionPermissionGate } = ctx;
  const subagentTools = deps.toolFilter
    ? agentTools.filter((t) => toolFilterAllows(deps.toolFilter!, t.name))
    : agentTools;
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
  }: {
    script: string;
    args?: unknown;
  }): Promise<{ ok: boolean; totalTokens: number; value: unknown }> => {
    const batchId = `script-${crypto.randomUUID()}`;
    const results: SubagentResult[] = [];
    const scriptController = new AbortController();
    emit({
      type: "delegation_batch_started",
      batchId,
      label: "script",
      source: "workflow",
      agentCount: 0,
    });
    let value: unknown;
    let failed = false;
    try {
      const evaluated = await evaluateOrchestrationScript({
        script,
        args,
        signal: scriptController.signal,
        primitives: {
          agent: async (prompt, opts) => {
            const result = await delegationExecutor.runSubagent(
              {
                batchId,
                agentId: randomUUID(),
                prompt,
                ...(opts?.schema ? { schema: opts.schema } : {}),
                ...(opts?.label ? { label: opts.label } : {}),
              },
              scriptController.signal,
            );
            results.push(result);
            return result;
          },
          pipeline: (items, fn) => Promise.all(items.map(fn)),
        },
      });
      value = evaluated.value;
    } catch (err) {
      failed = true;
      scriptController.abort();
      throw err;
    } finally {
      const totalTokens = results.reduce(
        (acc, r) =>
          acc +
          (r.usage?.inputTokens ?? 0) +
          (r.usage?.outputTokens ?? 0) +
          (r.usage?.cacheReadTokens ?? 0) +
          (r.usage?.cacheWriteTokens ?? 0),
        0,
      );
      const ok = !failed && results.every((r) => r.ok);
      emit({
        type: "delegation_batch_completed",
        batchId,
        ok,
        agentCount: results.length,
        totalTokens,
      });
    }
    const totalTokens = results.reduce(
      (acc, r) =>
        acc +
        (r.usage?.inputTokens ?? 0) +
        (r.usage?.outputTokens ?? 0) +
        (r.usage?.cacheReadTokens ?? 0) +
        (r.usage?.cacheWriteTokens ?? 0),
      0,
    );
    const ok = results.every((r) => r.ok);
    return { ok, totalTokens, value };
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
    readAgentDefinition: async (name) => {
      if (!isValidWorkflowName(name)) return null;
      if (deps.workspaceAccess !== "read_write") return null;
      try {
        return await Bun.file(join(deps.workspaceRoot, ".oma", "agents", `${name}.md`)).text();
      } catch {
        return null;
      }
    },
  });

  const orchestrateTools = createOrchestrateTool({
    runScript,
    writeScript: (name, content) => {
      if (!isValidWorkflowName(name)) {
        throw new Error(`invalid workflow name (allowed: [a-z0-9-], max 64): ${name}`);
      }
      if (deps.workspaceAccess !== "read_write") {
        throw new Error("workflow scripts cannot be saved in a read_only workspace");
      }
      const targetPath = new WorkspaceSandbox(deps.workspaceRoot).validateNew(
        join(".oma", "workflow", `${name}.js`),
      );
      const planBlocked = planModeRefusal(deps.planMode, targetPath);
      if (planBlocked) throw new Error(planBlocked);
      const policyBlocked = pathPolicyRefusal(targetPath);
      if (policyBlocked) throw new Error(policyBlocked);
      const dir = join(deps.workspaceRoot, ".oma/workflow");
      mkdirSync(dir, { recursive: true });
      writeFileSync(targetPath, content);
    },
    readScript: async (name) => {
      if (!isValidWorkflowName(name)) return null;
      try {
        return await Bun.file(join(deps.workspaceRoot, ".oma/workflow", `${name}.js`)).text();
      } catch {
        return null;
      }
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
