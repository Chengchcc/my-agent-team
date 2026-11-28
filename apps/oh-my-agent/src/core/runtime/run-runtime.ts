import { type ModelRuntime, type ModelRuntimeEntry, resolveModelAlias } from "@chengchenccc/ai";
import type { AIMessageChunk, JsonSchema, Message } from "@chengchenccc/message";
import { createCoordinationRegistry } from "../coordination/registry.js";
import { debugLog } from "../debug-log.js";
import {
  type ContextBudget,
  type ContextSummarizer,
  createInMemorySessionStore,
  createOmaSession,
  type OmaLoopEvent,
  type OmaSession,
  type Plugin,
  type PluginRuntime,
  type PluginTool,
  type SessionStore,
} from "../index.js";
import { createLearnTool } from "../memory/learn.js";
import { createManageSkillTool } from "../memory/manage-skill.js";
import { managedSkillsDir } from "../memory/managed-skills.js";
import { backfillLearnedLessons, getVectorMemory } from "../memory/vector-memory.js";
import { createRecallTool, createRetainTool } from "../memory/vector-tools.js";
import type { OrchestrationScriptResult } from "../orchestrate/tool.js";
import type { PluginMcpConfig } from "../plugins/plugin-resolve.js";
import {
  loadProjectSettings,
  type ProjectSettings,
  type PruneKnobs,
  type RuntimeKnobs,
  resolveRuntimeKnobs,
} from "../settings/project-settings.js";
import { createAskQuestionTool } from "../tools/ask-question.js";
import { type BashSandbox, resolveBashSandbox } from "../tools/bash-sandbox.js";
import type { WebFetchPort, WebSearchPort } from "../tools/index.js";
import type { McpMountReport } from "../tools/mcp-mount.js";
import { createSkill } from "../tools/skill.js";
import { createTodo, createTodoReadTool } from "../tools/todo.js";
import { createFileTodoStore } from "../tools/todo-store.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./approval.js";
import { buildSummarizationRequest } from "./compaction-prompt.js";
import { estimateMessageTokens, triggerRatioFor } from "./context-estimate.js";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "./contract/index.js";
import type { CreateOmaRuntimeOptions } from "./create-runtime.js";
import { fakeProvider } from "./fake-provider.js";
import { reasoningEffortOptions } from "./model-effort.js";
import { createDelegationStack } from "./run-delegation.js";
import { createRunPermissionGates } from "./run-permissions.js";
import {
  buildNativeToolStage,
  mountedProvidesLeaf,
  toPluginTool,
  wrapperBackstopMs,
} from "./run-tools.js";
import { loadRuntimeCatalog, registerProvidersFromCatalog } from "./runtime-catalog.js";
import { loadStreamRules } from "./stream-rules.js";
import { toolFilterAllows } from "./tool-filter.js";

export { toPluginTool, wrapperBackstopMs };

/** Wall-clock cap on ONE model call: a silent/stuck provider must not leave
 *  the Run in `running` forever (it fails, with no auto-retry). */
const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

/** Safety ceiling on loop steps. pi's loop has no cap (natural stop or user
 *  abort terminates); this is a runaway-cost guard, not a design limit. */
const DEFAULT_MAX_STEPS = 500;

/** Settings-shaped prune knobs → the loop's PruneConfig (the only place the
 *  string list becomes the Set the pruner wants). */
function toPruneConfig(prune: PruneKnobs): {
  protectTokens?: number;
  minimumSavings?: number;
  protectedTools?: ReadonlySet<string>;
} {
  return {
    ...(prune.protectTokens !== undefined ? { protectTokens: prune.protectTokens } : {}),
    ...(prune.minimumSavings !== undefined ? { minimumSavings: prune.minimumSavings } : {}),
    ...(prune.protectedTools ? { protectedTools: new Set(prune.protectedTools) } : {}),
  };
}

/** Resolve one catalog entry by canonical id, honoring the legacy alias
 *  table. The Run's model is the ONLY budget/summarizer/stream authority —
 *  a catalog-first model with a different window would compact at the wrong
 *  threshold, and an unknown id is a hard failure (never a silent fallback). */
export async function resolveModelEntry(
  modelRuntime: ModelRuntime,
  modelId: string,
): Promise<ModelRuntimeEntry> {
  const target = resolveModelAlias(modelId);
  const catalog = await modelRuntime.getCatalog();
  const model = catalog.models.find((m) => `${m.providerId}/${m.modelId}` === target);
  if (!model) throw new Error(`model not found in catalog: ${modelId}`);
  return model;
}

/** Deps for ONE Run's runtime assembly. Extends the mode-facing
 *  CreateOmaRuntimeOptions as the SINGLE source of shared fields (a new
 *  option automatically reaches the assembly — the two bags can no longer
 *  drift) minus the facade-only fields (onEvent / sessionTranscript /
 *  pluginComponents), plus the assembly-only mounts below. The runtime is
 *  per-Run: a fresh in-memory SessionStore and a fresh OmaSession are
 *  created for every execute() — no state is shared across Runs except the
 *  process-level Provider/ModelRuntime and the injected coordination
 *  registry. */
export interface RunRuntimeDeps
  extends Omit<CreateOmaRuntimeOptions, "onEvent" | "sessionTranscript" | "pluginComponents"> {
  webSearch?: WebSearchPort;
  webFetch?: WebFetchPort;
  /** Loaded plugin code components (mode layer already applied the trust
   *  policy); the runtime only mounts them. */
  codePlugins?: readonly Plugin[];
  /** Plugin .mcp.json configs (already trust-approved by the mode layer). */
  pluginMcpServers?: readonly PluginMcpConfig[];
  /** MCP server names this run serves over MCP-over-ACP instead: the
   *  file/plugin mounts skip them so the identity-carrying rail is the only
   *  one under that name. */
  excludeMcpServerNames?: ReadonlySet<string>;
}

export interface RunRuntime {
  readonly runId: string;
  readonly store: SessionStore;
  /** Resolved knobs for THIS Run (never the process env): create-runtime
   *  reads the post-run memory settings from here. */
  readonly knobs: RuntimeKnobs;
  readonly session: OmaSession;
  /** REAL per-server MCP mount outcomes for this runtime (connect+listTools). */
  readonly mcpMountReports: readonly McpMountReport[];
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget | undefined;
  /** Set before startLoop so modelStream resolves the run's model. */
  setActiveRun(run: AgentRunSnapshot | null): void;
  /** Orchestration mode: execute an isolated JS script (agent() subagents +
   *  read-only tools) and return its value. Used directly by create-runtime
   *  when the Run input carries `workflow`, and by the `orchestrate` tool. */
  executeWorkflow(input: {
    script: string;
    args?: unknown;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<OrchestrationScriptResult>;
  /** Subagent usage accumulated across delegation_agent_completed events
   *  (T5/B6): the run's outcome merges it so fan-out spend reaches the
   *  product ledger, not just the advisory gate. */
  delegationUsage(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Close MCP clients etc. Call after the run settles. */
  close(): Promise<void>;
}

/** Single provider assembly shared by the CLI catalog (--list-models) and
 *  Run loops: register built-in providers from the process env. The fake
 *  deterministic provider is available for tests. */
export function registerBuiltinProviders(
  runtime: ModelRuntime,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.OMA_FAKE_PROVIDER === "1") {
    runtime.registerProvider(fakeProvider(env));
    return;
  }
  const catalog = loadRuntimeCatalog(env);
  registerProvidersFromCatalog(runtime, catalog, env);
}

/** Advance an async iterator, racing each chunk against the combined
 *  signal. Providers that ignore the signal (e.g. a generator sleeping
 *  forever) can no longer hold the Run hostage: abort rejects immediately
 *  instead of waiting for the provider to notice. Pure module helper —
 *  shared by the run's summarizer and the main model stream. */
async function nextBounded<T>(
  iter: AsyncIterator<T>,
  combined: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (combined.aborted) {
    throw new Error(timeoutSignal.aborted ? "model timed out" : "model call aborted");
  }
  let settled = false;
  const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<T>>();
  const onAbort = () => {
    settled = true;
    void iter.return?.().catch(() => {});
    reject(new Error(timeoutSignal.aborted ? "model timed out" : "model call aborted"));
  };
  combined.addEventListener("abort", onAbort, { once: true });
  iter
    .next()
    .then(
      (r) => {
        if (settled) return; // aborted already; drop the late chunk
        resolve(r);
      },
      (err) => {
        if (!settled) reject(err);
      },
    )
    .finally(() => combined.removeEventListener("abort", onAbort));
  return promise;
}

/** Output cap for one summarization call: enough to write a summary, never more
 *  than the model itself allows. NOTE what this can and cannot fix — the run's
 *  model and the summarizer are the same entry, so lowering a model's cap
 *  lowers the summary's ceiling too, and NO per-call value can raise it above
 *  the model's own (live 2026-10-13: a 64-token model cap starved summaries to
 *  empty text by construction; the fixable part was the silence, not this). */
export const SUMMARY_MAX_TOKENS = 4_096;

export function summaryMaxTokens(modelMaxOutputTokens: number): number {
  return Math.min(SUMMARY_MAX_TOKENS, modelMaxOutputTokens);
}

/** Model plumbing stage: everything bound to the RUN's model — display
 *  identity, the compaction summarizer (same provider/credentials, no
 *  catalog-first surprises), the context budget from the run model's
 *  window, and the wall-clock caps. */
function buildModelPlumbing(
  deps: RunRuntimeDeps,
  ctx: { currentModel: ModelRuntimeEntry; knobs: RuntimeKnobs },
): {
  resolveModel: (modelId: string) => Promise<{ provider: string; id: string }>;
  summarize: ContextSummarizer;
  contextBudget: ContextBudget;
  modelTimeoutMs: number;
  approvalDeadlineMs: number;
} {
  const { currentModel, knobs } = ctx;
  // Resolve the model display identity for a run's ref - used by the Session
  // to render the per-loop Meta (workspace/model fact line). The Session is
  // the sole Meta owner; the Run runtime never passes a meta string.
  const resolveModel = async (modelId: string): Promise<{ provider: string; id: string }> => {
    const model = await resolveModelEntry(deps.modelRuntime, modelId);
    return { provider: model.providerId, id: model.modelId };
  };

  // Wall-clock cap on a single model call: a silent/stuck provider must not
  // leave the Run in `running` forever. The timeout aborts the call and the
  // Run fails (no auto-retry). Overridable via env for tests.
  const modelTimeoutMs = knobs.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const approvalDeadlineMs = knobs.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  // Summarizer: call the RUN's model through ModelRuntime. Same provider/
  // credentials as the run - no surprise provider switch, no catalog-first cost
  // surprises. No summaryModel config until real cost data demands one. The
  // request shape (system prompt + `<conversation>` wrapper) lives in
  // compaction-prompt.ts so it is testable without a store or a model.
  const summarize: ContextSummarizer = async (messages, signal, opts) => {
    const summaryMessages = buildSummarizationRequest(messages, {
      previousSummary: opts?.previousSummary,
    });
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const stream = deps.modelRuntime.stream(
      currentModel.providerId,
      currentModel.modelId,
      summaryMessages,
      {
        signal: combined,
        maxTokens: summaryMaxTokens(currentModel.maxOutputTokens),
      },
    );
    const iter = stream[Symbol.asyncIterator]();
    let text = "";
    try {
      for (;;) {
        const next = await nextBounded(iter, combined, timeoutSignal);
        if (next.done) break;
        if (next.value.delta?.type === "text") text += next.value.delta.text;
      }
    } finally {
      if (!combined.aborted) await iter.return?.().catch(() => {});
    }
    // An empty answer is a configuration symptom more often than a model one (a
    // tiny output cap on this very model, a prompt the model refused), and the
    // stored summary is the only place anyone would ever see it: the run
    // reports success either way. Say what happened where it will be read.
    return text || "[empty summary: the model returned no text — check this model's output cap]";
  };

  // ContextBudget from the RUN model's context window: compaction triggers
  // when the LIVE context leaves less than the reserve for the next model call,
  // neither premature nor too late. The reserve (not a fixed ratio) is what
  // scales, so a large window is not charged for headroom it never needs.
  const contextBudget: ContextBudget = {
    estimate: (m) => estimateMessageTokens(m),
    limit: currentModel.contextWindow,
    triggerRatio: triggerRatioFor(currentModel.contextWindow, knobs.compactReserveTokens),
  };
  return { resolveModel, summarize, contextBudget, modelTimeoutMs, approvalDeadlineMs };
}

/** The run's model-stream shape (main loop voice; subagents and the
 *  classifier ride the same stream). */
/** Build the complete Runtime assembly for exactly ONE Run. The Run's
 *  in-memory SessionStore is created here (never shared with other Runs);
 *  the model is resolved per run from the AgentRunSnapshot. */
export async function assembleRunRuntime(deps: RunRuntimeDeps): Promise<RunRuntime> {
  const store = createInMemorySessionStore();
  // M9: `.oma/settings.json` lives in the agent-writable workspace. Standalone
  // modes (tui/print/json) honor every knob; backend RPC runs honor ONLY
  // bashSandbox (enabling it = stricter, fail-safe) — a workspace file must
  // never steer the product's permission classifier, web, steps or timeouts.
  // Knobs are plain DI values (deps.settings wins, then the process env as a
  // deployment default): the runtime NEVER writes process.env, so a process
  // that runs many Runs (the TUI) cannot leak one Run's config into the next.
  const loaded = loadProjectSettings(deps.workspaceRoot);
  const projectSettings: ProjectSettings = deps.gateWorkspaceMcp
    ? loaded
    : { bashSandbox: loaded.bashSandbox };
  const knobs = deps.settings ?? resolveRuntimeKnobs(projectSettings);
  const currentModel = await resolveModelEntry(deps.modelRuntime, deps.modelId);
  // OS bash sandbox (BashSandbox design): enabled via .oma/settings.json
  // (TUI /settings or direct edit). resolveBashSandbox throws on
  // enabled-but-tool-missing — the Run fails loudly rather than silently
  // running unconstrained.
  let bashSandbox: BashSandbox | undefined;
  const sandboxConfigured = projectSettings.bashSandbox === true;
  if (sandboxConfigured) {
    bashSandbox = resolveBashSandbox({
      workspaceRoot: deps.workspaceRoot,
      enabled: true,
    });
  }
  // Yolo needs a boundary that does not depend on judgment (the 2026
  // consensus after the s1ngularity incident: an installed agent CLI with
  // its permission flag disabled is a standing capability any package can
  // borrow). Force the OS bash sandbox when the platform has one; a missing
  // one degrades with a loud log instead of failing the Run — the remaining
  // static boundaries (workspace containment for file tools, secret
  // stripping, egress rules) still hold.
  const yoloWantsBoundary = deps.permissionMode === "yolo" && bashSandbox === undefined;
  if (yoloWantsBoundary) {
    try {
      bashSandbox = resolveBashSandbox({ workspaceRoot: deps.workspaceRoot, enabled: true });
      debugLog("oma", "yolo: OS bash sandbox force-enabled");
    } catch (err) {
      debugLog(
        "oma",
        `yolo: no OS bash sandbox available (${
          err instanceof Error ? err.message : String(err)
        }) — bash runs unsandboxed; workspace/egress boundaries remain`,
      );
    }
  }
  const scope = deps.coordinationScope ?? deps.runId;
  // ADR 0063: job lifecycle rides the loop's event stream (late-bound, the
  // session does not exist yet). Best-effort self-driving; a broken emit must
  // never break a job.
  const jobEvents: { fn: ((event: OmaLoopEvent) => void) | null } = { fn: null };
  const registry =
    deps.registry ??
    createCoordinationRegistry({
      onJobChange: (job) => {
        try {
          jobEvents.fn?.({ type: "job_state", ...job });
        } catch {
          /* best effort */
        }
      },
    });
  const toolStage = await buildNativeToolStage(deps, {
    knobs,
    bashSandbox,
    scope,
    registry,
  });
  const { agentTools, nativeToolsPlugin, closeMounted } = toolStage;
  // Managed-skills dir joins discovery on MUTABLE runs (dead-last): a skill
  // minted this run is loadable via skill_load in the same run, and
  // manage_skill's refresh re-scans it. Read-only runs keep the frozen roots.
  const managedRoot = managedSkillsDir();
  const skillRoots =
    deps.workspaceAccess === "read_write" && !deps.skillRoots.includes(managedRoot)
      ? [...deps.skillRoots, managedRoot]
      : deps.skillRoots;
  const { plugin: skillPlugin, refresh: refreshSkills } = createSkill({ roots: skillRoots });
  const plugins: Plugin[] = [nativeToolsPlugin, skillPlugin];
  // Plugin code-tool names (post native-conflict filter): the auto-mode
  // classifier gate needs them by name — plugin tools have no naming
  // convention, so membership is collected at assembly.
  const pluginCodeToolNames = new Set<string>();
  if (deps.codePlugins?.length) {
    if (deps.permissionMode !== "deny") {
      // Native wins on tool-name conflicts (spec conflict matrix).
      const nativeNames = new Set(plugins.flatMap((p) => (p.tools ?? []).map((t) => t.name)));
      for (const cp of deps.codePlugins) {
        // A shadowed plugin tool is dropped, not merged (spec conflict
        // matrix). Say so: an operator debugging a missing tool otherwise gets
        // no signal at all.
        for (const t of cp.tools ?? []) {
          if (nativeNames.has(t.name)) {
            debugLog("oma", `plugin tool "${t.name}" shadowed by a native tool; dropped`);
          }
        }
        const tools = (cp.tools ?? [])
          .filter((t) => !nativeNames.has(t.name))
          .map((t) => {
            pluginCodeToolNames.add(t.name);
            return t;
          });
        plugins.push({
          name: cp.name,
          ...(cp.hooks ? { hooks: cp.hooks } : {}),
          ...(tools.length ? { tools } : {}),
        });
      }
    }
    // permissionMode "deny" drops plugin code components entirely (MVP
    // enforcement point); native tools are unaffected and the Run proceeds.
  }
  // Native ask_question (oh-my-pi style HITL): same conflict rule as todo —
  // the backend can inject its own MCP ask_question (product surfaces); the
  // injected one wins, standalone workspaces get the native tool.
  // Native ask_question (oh-my-pi style HITL): same conflict rule as todo —
  // the injected product tool wins over the built-in default.
  const hasInjectedAsk = mountedProvidesLeaf(toolStage, "ask_question");
  const askAllowed = deps.toolFilter ? toolFilterAllows(deps.toolFilter, "ask_question") : true;
  if (!hasInjectedAsk && askAllowed) {
    plugins.push({
      name: "oma-native-ask",
      tools: [createAskQuestionTool()],
    });
  }
  // Native todo (.oma/todo.json): installed when NOTHING else already
  // provides todo_write (the backend injects its own MCP todo_write into
  // RPC workspaces — the specific injection wins over the built-in default;
  // standalone workspaces get the native one). One rule replaces the old
  // per-mode enableNativeTodo flag.
  const hasInjectedTodo = mountedProvidesLeaf(toolStage, "todo_write");
  const todoAllowed = deps.toolFilter ? toolFilterAllows(deps.toolFilter, "todo_write") : true;
  // Explicit durable-lesson capture + managed-skill CRUD (omp learn/manage_skill).
  // STANDALONE-ONLY (localMemory, set by print/json/tui via shared.ts): the
  // product RPC path keeps its own memory semantics — a workspace file must
  // never steer the product, and the product surface stays frozen.
  if (deps.workspaceAccess === "read_write" && deps.localMemory && !deps.planMode) {
    plugins.push({
      name: "oma-native-learn",
      tools: [
        createLearnTool({
          workspaceRoot: deps.workspaceRoot,
          vector: deps.vectorMemory ? getVectorMemory(deps.workspaceRoot) : null,
          skillRoots: deps.skillRoots,
        }),
        // Direct managed-skill CRUD with live index refresh (omp parity:
        // learn defers discovery to a later session, manage_skill doesn't).
        createManageSkillTool({
          skillRoots: deps.skillRoots,
          refreshSkills,
        }),
      ],
    });
    // Vector memory (standalone-only: the product RPC path keeps its own
    // memory semantics; a workspace file never steers it). One lazy
    // (store, provider) per workspace; missing model = FTS-only recall.
    if (deps.vectorMemory) {
      const vector = getVectorMemory(deps.workspaceRoot);
      if (vector) {
        void backfillLearnedLessons(vector, deps.workspaceRoot).catch(() => {});
        plugins.push({
          name: "oma-native-vector-memory",
          tools: [createRecallTool(vector), createRetainTool(vector)],
        });
      }
    }
  }
  const nativeTodoWanted = !hasInjectedTodo && todoAllowed;
  if (nativeTodoWanted) {
    const todoStore = createFileTodoStore(deps.workspaceRoot, deps.todoScope);
    const todoBase = createTodo({ store: todoStore });
    plugins.push({
      name: todoBase.name,
      hooks: todoBase.hooks,
      tools: [...(todoBase.tools ?? []), createTodoReadTool({ store: todoStore })],
      meta: [
        {
          name: "Current Tasks",
          render: () => {
            const items = todoStore.read();
            if (items.length === 0) return "None yet. Use todo_write to track tasks.";
            const marks: Record<string, string> = {
              pending: "- [ ]",
              in_progress: "- [~]",
              done: "- [x]",
              cancelled: "- [ ]",
            };
            return items
              .map((t) => `${marks[t.status] ?? "- [ ]"} ${t.text} (id: ${t.id})`)
              .join("\n");
          },
        },
      ],
    });
  }

  let activeRun: AgentRunSnapshot | null = null;

  // Model plumbing: display-identity resolver, summarizer, compaction
  // budget, and the wall-clock caps — all bound to the RUN's model.
  const { resolveModel, summarize, contextBudget, modelTimeoutMs, approvalDeadlineMs } =
    buildModelPlumbing(deps, { currentModel, knobs });

  // PluginRuntime: gives hooks access to model stream, store, workspace,
  // emit, and abort signal. Plugins capture config in closures; rt provides
  // runtime capabilities at call time.
  // Two-phase: sessionEmit is bound after session creation (the session's
  // emit method doesn't exist until createOmaSession returns).
  let sessionEmit: ((event: OmaLoopEvent) => void) | null = null;
  // The workflow executor rides the SAME model stream + summarizer as the
  // main loop; subagents get the file tools only (no workflow/product tools).
  // Product budget gate (T11a): the Loop freezes its remaining daily budget
  // on the Run; the executor refuses new spawns once the completed agents'
  // usage estimate exceeds it. Advisory - the product dailyCap stays the
  // hard gate. No budget on the run = no gate.
  let delegationSpentTokens = 0;
  const delegationUsageAccum = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const delegationBudgetGate = (): { allowed: boolean; reason?: string } => {
    const budget = activeRun?.workflowBudgetTokens;
    if (budget == null) return { allowed: true };
    if (delegationSpentTokens >= budget) {
      return { allowed: false, reason: "delegation budget exhausted" };
    }
    return { allowed: true };
  };
  // Permission gates (ADR 0020): one pipeline for native + plugin tools;
  //  subagent sessions get the same policy with their own intent texts.
  const { permissionGate, makeSessionPermissionGate } = createRunPermissionGates(deps, {
    knobs,
    store,
    streamModel,
    pluginCodeToolNames,
    approvalDeadlineMs,
    bashSandboxed: bashSandbox !== undefined,
  });

  // --tools filter also governs the subagent table: a `--tools read` Run must
  // not hand its children bash/write. Applied here (the executor receives the
  // post-filter list) and again to the main session's plugin table below.
  const delegationEmit = (event: OmaLoopEvent): void => {
    if (event.type === "delegation_agent_completed" && event.usage) {
      const usage = event.usage;
      if (typeof usage === "object") {
        const tokens = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);
        const u = usage as Record<string, unknown>;
        delegationSpentTokens +=
          tokens(u.inputTokens) +
          tokens(u.outputTokens) +
          tokens(u.cacheReadTokens) +
          tokens(u.cacheWriteTokens);
        delegationUsageAccum.inputTokens += tokens(u.inputTokens);
        delegationUsageAccum.outputTokens += tokens(u.outputTokens);
        delegationUsageAccum.cacheReadTokens += tokens(u.cacheReadTokens);
        delegationUsageAccum.cacheWriteTokens += tokens(u.cacheWriteTokens);
      }
    }
    sessionEmit?.(event);
  };
  const {
    delegationExecutor,
    runScript,
    plugins: delegationPlugins,
    backgroundSupervision,
  } = createDelegationStack(deps, {
    registry,
    scope,
    agentTools,
    summarize,
    contextBudget,
    makeSessionPermissionGate,
    streamModel,
    budgetGate: delegationBudgetGate,
    emit: delegationEmit,
  });
  plugins.push(...delegationPlugins);

  const pluginRuntime: PluginRuntime = {
    streamModel: (providerId, modelId, messages, opts) =>
      deps.modelRuntime.stream(providerId, modelId, messages, opts),
    store,
    sessionId: deps.runId,
    workspaceRoot: deps.workspaceRoot,
    emit: (event) => {
      sessionEmit?.(event);
    },
    signal: new AbortController().signal,
  };

  // Hoisted so both the main session and workflow subagent sessions share it.
  async function* streamModel(
    messages: readonly Message[],
    signal?: AbortSignal,
    tools?: readonly PluginTool[],
    modelIdOverride?: string,
    responseFormat?: JsonSchema,
  ): AsyncIterable<AIMessageChunk> {
    const run = activeRun;
    if (!run) throw new Error("no active run: model unresolved");
    // 3.4: role-pinned model override resolves through the SAME catalog —
    // an unknown/absent model throws here, which is the authorization
    // boundary (no bypassing the catalog to mint expensive models).
    const modelId = modelIdOverride ?? run.model.modelId;
    const model = await resolveModelEntry(deps.modelRuntime, modelId);
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const stream = deps.modelRuntime.stream(model.providerId, model.modelId, messages, {
      signal: combined,
      cacheControl: true,
      ...reasoningEffortOptions(run.model.reasoningEffort),
      ...(responseFormat ? { responseFormat } : {}),
      tools: tools?.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    const iter = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await nextBounded(iter, combined, timeoutSignal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (!combined.aborted) await iter.return?.().catch(() => {});
    }
  }

  // pi's loop has no step cap: termination is the model's natural stop or
  // user abort. We keep a high safety ceiling (runaway-cost guard) that is
  // env-overridable; 32 was far too small for real tasks.
  const maxSteps = knobs.maxSteps ?? DEFAULT_MAX_STEPS;
  // TTSR-style stream rules from .oma/rules/*.md (workspace-scoped).
  const streamRules = loadStreamRules(deps.workspaceRoot);
  // --tools filter (CLI): applied ONCE to the final tool table (native +
  //  MCP + plugin tools) — the model never sees filtered-out tools.
  const finalPlugins = deps.toolFilter
    ? plugins.map((p) => ({
        ...p,
        ...(p.tools
          ? { tools: p.tools.filter((t) => toolFilterAllows(deps.toolFilter!, t.name)) }
          : {}),
      }))
    : plugins;
  const session = createOmaSession({
    // Per-Run store ⇒ session id == run id (see core/runtime/README.md).
    sessionId: deps.runId,
    store,
    plugins: finalPlugins,
    pluginRuntime,
    titleEnabled: knobs.titleEnabled ?? true,
    conversationTitled: knobs.conversationTitled === true,
    maxSteps,
    maxForceContinues: 4,
    // Opt-in: pruning rewrites what the model sees, so it applies only when a
    // Run was configured for it (see PruneKnobs).
    ...(knobs.prune ? { pruneConfig: toPruneConfig(knobs.prune) } : {}),
    modelStream: streamModel,
    summarize,
    contextBudget,
    resolveModel,
    ...(streamRules.length > 0 ? { streamRules } : {}),
    ...(deps.onPersistMessages ? { onPersistMessages: deps.onPersistMessages } : {}),
    ...(deps.onParkedTurn ? { onParkedTurn: deps.onParkedTurn } : {}),
    ...(permissionGate ? { permissionGate } : {}),
    askHandler: deps.askHandler,
    background: backgroundSupervision,
  });

  // Bind the plugin runtime's emit to the session's emit (two-phase init).
  sessionEmit = (event) => session.emit(event);
  jobEvents.fn = sessionEmit;

  return {
    runId: deps.runId,
    store,
    knobs,
    session,
    mcpMountReports: toolStage.mcpReports,
    summarize,
    contextBudget,
    setActiveRun(run) {
      activeRun = run;
    },
    executeWorkflow: (input) => runScript(input),
    delegationUsage: () => ({ ...delegationUsageAccum }),
    async close() {
      // Live subagent loops must not outlive the Run. A per-Run registry is
      // then dropped entirely (nothing can outlive it); a surface-provided
      // one keeps completed handles for a later Run's resume.
      delegationExecutor.stopLiveSubagents();
      if (!deps.registry) {
        // Kill what this Run owns BEFORE dropping the table: bg bash/eval
        // children must not outlive the Run just because the bookkeeping
        // did (clearAll alone orphans the processes).
        registry.stopRunningEntries();
        registry.clearAll();
      }
      // Tear down mounted MCP clients so no child process or connection
      // outlives the Run. Each close is BOUNDED: a stuck transport (e.g. an
      // SSE socket that never answers close) must not wedge the child.
      const closeWithTimeout = (p: Promise<unknown>): Promise<unknown> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((r) => {
          timer = setTimeout(r, 2000);
          timer.unref?.();
        });
        return Promise.race([p, timeout]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
      };
      const closePromises: Promise<unknown>[] = [];
      closePromises.push(closeWithTimeout(closeMounted()));
      closePromises.push(closeWithTimeout(store.close()));
      await Promise.allSettled(closePromises);
    },
  };
}

export type { AgentRunSnapshot, PluginTool, ProjectedHistoryItem };
