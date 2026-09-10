import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRunSnapshot,
  debugLog,
  type ProjectedHistoryItem,
} from "@chengchenccc/agent-contract";
import { type ModelRuntime, type ModelRuntimeEntry, resolveModelAlias } from "@chengchenccc/ai";
import type { AIMessageChunk, JsonSchema, Message } from "@chengchenccc/message";
import { createHubTool } from "../coordination/index.js";
import { type CoordinationRegistry, createCoordinationRegistry } from "../coordination/registry.js";
import { createDelegationExecutor, type SubagentResult } from "../delegation/executor.js";
import { createDelegationTools, isValidWorkflowName } from "../delegation/tool.js";
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
import { evaluateOrchestrationScript } from "../orchestrate/script-runner.js";
import { createOrchestrateTool } from "../orchestrate/tool.js";
import type { PluginMcpConfig } from "../plugins/plugin-resolve.js";
import { isFileTrusted, readTrustedPlugins } from "../plugins/plugin-trust.js";
import {
  loadProjectSettings,
  type ProjectSettings,
  type PruneKnobs,
  type RuntimeKnobs,
  resolveRuntimeKnobs,
} from "../settings/project-settings.js";
import { createAskQuestionTool } from "../tools/ask-question.js";
import { type BashSandbox, resolveBashSandbox } from "../tools/bash-sandbox.js";
import {
  createBashTool,
  createDdgWebSearchPort,
  createEditTool,
  createEvalTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createPortWebFetchTool,
  createPortWebSearchTool,
  createReadImageTool,
  createReadTool,
  createStdWebFetchPort,
  createTreeTool,
  createWriteTool,
  type WebFetchPort,
  type WebSearchPort,
} from "../tools/index.js";
import {
  type McpMountReport,
  mountWorkspaceMcpServers,
  withCallTimeout,
} from "../tools/mcp-mount.js";
import { createSkill } from "../tools/skill.js";
import { createTodo, createTodoReadTool } from "../tools/todo.js";
import { createFileTodoStore } from "../tools/todo-store.js";
import {
  type ApprovalHandler,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  withApprovalDeadline,
} from "./approval.js";
import { fakeProvider } from "./fake-provider.js";
import { reasoningEffortOptions } from "./model-effort.js";
import {
  classifyPermissionAction,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  isCriticalDeletion,
} from "./permission-classifier.js";
import { loadRuntimeCatalog, registerProvidersFromCatalog } from "./runtime-catalog.js";
import { loadStreamRules } from "./stream-rules.js";
import { type ToolFilter, toolFilterAllows } from "./tool-filter.js";

/** Token estimation via content char/4 (approx 1 token per 4 chars of
 *  English/code). More accurate than JSON.stringify char/4 which includes
 *  ~30% syntax overhead from key names, quotes, braces. Counts actual text +
 *  block content, adds a fixed overhead per message for role/structure
 *  framing. Swap for a real tokenizer (tiktoken, provider SDK) by replacing
 *  this function — the ContextBudget.estimate interface is the extension
 *  point. */
function estimateMessageTokens(message: Message): number {
  let chars = message.text?.length ?? 0;
  if (message.blocks) {
    for (const b of message.blocks) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      else if (b.type === "tool_result" && typeof b.content === "string") chars += b.content.length;
      else if (b.type === "thinking" && typeof b.text === "string") chars += b.text.length;
    }
  }
  // ~4 chars/token for content + 4 tokens framing overhead per message
  // (role tag, separators — matches Anthropic's documented overhead).
  return Math.ceil(chars / 4) + 4;
}

/** Default native tool timeout (ms) for file/web/bash unless overridden. */
const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000;

/** Wall-clock cap on ONE model call: a silent/stuck provider must not leave
 *  the Run in `running` forever (it fails, with no auto-retry). */
const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

/** Safety ceiling on loop steps. pi's loop has no cap (natural stop or user
 *  abort terminates); this is a runaway-cost guard, not a design limit. */
const DEFAULT_MAX_STEPS = 500;

function resolveNativeToolTimeout(defaultMs: number, maxToolTimeoutMs?: number): number {
  const cap = maxToolTimeoutMs ?? 0;
  if (Number.isFinite(cap) && cap > 0) return Math.min(defaultMs, cap);
  return defaultMs;
}

async function withToolTimeout(
  tool: PluginTool,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  options: { callId?: string; onOutput?: (partial: string) => void } | undefined,
  defaultMs: number,
  maxToolTimeoutMs?: number,
): Promise<Readonly<Record<string, unknown>>> {
  const timeoutMs = resolveNativeToolTimeout(defaultMs, maxToolTimeoutMs);
  if (timeoutMs <= 0) return tool.execute(input, signal, options);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withCallTimeout(
      tool.execute(input, controller.signal, options),
      tool.name,
      timeoutMs,
      signal,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function wrapNativeTool(
  tool: PluginTool,
  defaultMs = DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
  maxToolTimeoutMs?: number,
): PluginTool {
  return {
    ...tool,
    timeoutMs: resolveNativeToolTimeout(defaultMs, maxToolTimeoutMs),
    execute: (input, signal, options) =>
      withToolTimeout(tool, input, signal, options, defaultMs, maxToolTimeoutMs),
  };
}

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

/** Deps for ONE Run's runtime assembly. The runtime is per-Run: a fresh
 *  in-memory SessionStore and a fresh OmaSession are created for every
 *  execute() - no state is shared across Runs except the process-level
 *  Provider/ModelRuntime and the injected coordination registry. */
export interface RunRuntimeDeps {
  workspaceRoot: string;
  /** Gates tool installation: read_only runs omit write/edit/bash. */
  workspaceAccess: "read_only" | "read_write";
  runId: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id of the Run's model. The context
   *  budget and the summarizer bind to THIS model - never the catalog's
   *  first entry (which may be a different window or a different provider). */
  modelId: string;
  /** Skill pack roots (absolute dirs scanned for SKILL.md). Frozen per Run. */
  skillRoots: readonly string[];
  webSearch?: WebSearchPort;
  webFetch?: WebFetchPort;
  /** Real-time session-file persistence (pi appendMessage): fires after
   *  every conversational persist with the canonical messages written. */
  onPersistMessages?: (messages: readonly Message[]) => void;
  /** Loaded plugin code components (mode layer already applied the trust
   *  policy); the runtime only mounts them. */
  codePlugins?: readonly Plugin[];
  /** Plugin .mcp.json configs (already trust-approved by the mode layer). */
  pluginMcpServers?: readonly PluginMcpConfig[];
  /** Frozen Run permissionMode (ADR 0020 decision 7). "deny" drops plugin
   *  code components at assembly; native tools are unaffected (MVP scope). */
  permissionMode?: "ask" | "auto" | "deny";
  /** Resolved runtime knobs (see resolveRuntimeKnobs). Omitted = the runtime
   *  loads `.oma/settings.json` itself and overlays the process env. */
  settings?: RuntimeKnobs;
  /** --tools filter (CLI): applied to the final tool table (native + MCP +
   *  plugin) at assembly. Undefined = all tools. */
  toolFilter?: ToolFilter;
  /** Coordination scope for background jobs and subagent handles. TUI
   *  passes a process-stable key so handles survive follow-up Runs;
   *  backend defaults to the runId (one Run per process). */
  coordinationScope?: string;
  /** Registry backing that scope. Omitted = a fresh per-Run registry (its
   *  jobs and handle table are dropped on close()): the backend spawns one
   *  process per Run, so nothing outlives it. A long-lived surface (TUI)
   *  passes ONE process-wide instance so handles survive follow-up Runs. */
  registry?: CoordinationRegistry;
  /** Standalone modes (tui/print/json): the workspace's own .mcp.json is
   *  repo-controlled, so mount it only when content-trusted (record in
   *  <agentDir>/trusted-plugins.json; /mcp trust records it). Backend RPC
   *  leaves this unset — the workspace bridge writes that file and the
   *  product owns it. */
  gateWorkspaceMcp?: boolean;
  /** HITL approval pipeline (spec): resolves the ask-mode gate and
   *  tools' options.request. Absent + ask = fail-closed error results. */
  approvalHandler?: ApprovalHandler;
  /** M-bash: interactive pty console runner (TUI overlay). Present in TUI
   *  mode only — pty:true bash calls hand off here; absent = headless
   *  script-capture fallback. */
  readonly bashPtyConsole?: (
    command: string,
    cwd: string,
    env: Record<string, string>,
  ) => Promise<{ exitCode: number | null; tail: string; killed: boolean }>;
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
  setActiveRun(run: AgentRunSnapshot<"oma"> | null): void;
  /** Workflow mode: execute a vm-sandboxed script (agent() subagents) and
   *  return its value. Used directly by create-runtime when the Run input
   *  carries `workflow`, and by the workflow_run tool otherwise. */
  executeWorkflow(input: {
    script: string;
    args?: unknown;
  }): Promise<{ ok: boolean; totalTokens: number; value: unknown }>;
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
  if (projectSettings.bashSandbox) {
    bashSandbox = resolveBashSandbox({
      workspaceRoot: deps.workspaceRoot,
      enabled: true,
    });
  }
  const scope = deps.coordinationScope ?? deps.runId;
  const registry = deps.registry ?? createCoordinationRegistry();
  const agentTools: PluginTool[] = [
    createReadTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createReadImageTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    // ls and tree are the two directory views: ls is flat + mtime sorted
    // (cheap orientation), tree is recursive (structure). Both are read-side,
    // so they exist in read_only runs too.
    createLsTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createTreeTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createGlobTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
    createGrepTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
  ];
  if (deps.workspaceAccess === "read_write") {
    agentTools.push(createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    agentTools.push(createEditTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    const bashToolOpts: {
      workspaceRoot: string;
      scope: string;
      sandbox?: BashSandbox;
      timeouts?: { bashTimeoutMs?: number; maxToolTimeoutMs?: number };
      registry?: CoordinationRegistry;
      ptyConsole?: (
        command: string,
        cwd: string,
        env: Record<string, string>,
      ) => Promise<{ exitCode: number | null; tail: string; killed: boolean }>;
    } = { workspaceRoot: deps.workspaceRoot, scope, timeouts: knobs, registry };
    if (bashSandbox) bashToolOpts.sandbox = bashSandbox;
    if (deps.bashPtyConsole) bashToolOpts.ptyConsole = deps.bashPtyConsole;
    agentTools.push(createBashTool(bashToolOpts) as unknown as PluginTool);
    agentTools.push(
      createEvalTool({
        workspaceRoot: deps.workspaceRoot,
        scope,
        registry,
        ...(knobs.evalTimeoutMs !== undefined ? { timeoutMs: knobs.evalTimeoutMs } : {}),
      }) as unknown as PluginTool,
    );
  }
  // Generic .mcp.json mounting (ADR 0022): user servers + knowledge.
  // Skips "product-tools" (the manifest path owns it) and names that
  // collide with the native table. The mounted clients join the run's
  // teardown set so stdio children never outlive the run.
  // Standalone gating: an untrusted repo-controlled .mcp.json mounts
  // nothing (fail-closed) — the mode layer surfaces the warning.
  let includeWorkspaceMcp = true;
  if (deps.gateWorkspaceMcp) {
    const mcpJsonPath = join(deps.workspaceRoot, ".mcp.json");
    if (existsSync(mcpJsonPath) && !isFileTrusted(mcpJsonPath, readTrustedPlugins())) {
      includeWorkspaceMcp = false;
      debugLog("oma", `workspace .mcp.json untrusted; servers not mounted (use /mcp trust)`);
    }
  }
  const mounted = await mountWorkspaceMcpServers(
    deps.workspaceRoot,
    new Set(agentTools.map((t) => t.name)),
    deps.pluginMcpServers ?? [],
    includeWorkspaceMcp,
    {
      ...(knobs.mcpTimeoutMs !== undefined ? { mcpTimeoutMs: knobs.mcpTimeoutMs } : {}),
      ...(knobs.maxToolTimeoutMs !== undefined ? { maxToolTimeoutMs: knobs.maxToolTimeoutMs } : {}),
    },
  );
  const closeMounted = mounted.close;
  // Web tools default ON via the std ports (DDG search + guarded fetch);
  // NOTE: mounted MCP tools intentionally do NOT join agentTools — they are
  // appended once (unwrapped; withCallTimeout already binds their per-call
  // timeout) to nativeToolsPlugin below. Pushing them here too duplicated
  // every mounted tool and tripped validatePlugins on real servers.
  if (knobs.disableWeb !== true) {
    agentTools.push(
      createPortWebSearchTool(deps.webSearch ?? createDdgWebSearchPort()) as unknown as PluginTool,
      createPortWebFetchTool(deps.webFetch ?? createStdWebFetchPort()) as unknown as PluginTool,
    );
  }

  const bashDefault = knobs.bashTimeoutMs ?? DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
  const nativeTools = agentTools.map((t) =>
    wrapNativeTool(
      t,
      t.name === "bash" ? bashDefault : DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
      knobs.maxToolTimeoutMs,
    ),
  );
  const nativeToolsPlugin: Plugin = {
    name: "native-tools",
    tools: [...nativeTools, ...mounted.tools],
  };
  const plugins: Plugin[] = [nativeToolsPlugin, createSkill({ roots: deps.skillRoots })];
  // Plugin code-tool names (post native-conflict filter): the auto-mode
  // classifier gate needs them by name — plugin tools have no naming
  // convention, so membership is collected at assembly.
  const pluginCodeToolNames = new Set<string>();
  if (deps.codePlugins?.length) {
    if (deps.permissionMode !== "deny") {
      // Native wins on tool-name conflicts (spec conflict matrix).
      const nativeNames = new Set(plugins.flatMap((p) => (p.tools ?? []).map((t) => t.name)));
      const askGate = deps.permissionMode === "ask";
      for (const cp of deps.codePlugins) {
        const tools = (cp.tools ?? [])
          .filter((t) => !nativeNames.has(t.name))
          .map((t) => {
            pluginCodeToolNames.add(t.name);
            return t;
          })
          .map((t) =>
            askGate
              ? {
                  ...t,
                  async execute(
                    args: Readonly<Record<string, unknown>>,
                    signal?: AbortSignal,
                    options?: Parameters<PluginTool["execute"]>[2],
                  ) {
                    if (!deps.approvalHandler) {
                      return {
                        error: `${t.name}: approval required but no pipeline configured`,
                        isError: true,
                      };
                    }
                    const verdict = await withApprovalDeadline(
                      deps.approvalHandler({
                        callId: options?.callId ?? "",
                        toolName: t.name,
                        input: args,
                        source: "permission",
                      }),
                      approvalDeadlineMs,
                    );
                    if (verdict.decision === "deny") {
                      return {
                        error: `${t.name}: denied — ${verdict.reason ?? "user denied"}`,
                        isError: true,
                      };
                    }
                    return t.execute(args, signal, options);
                  },
                }
              : t,
          );
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
  const hasInjectedAsk = mounted.tools.some((t) => t.name === "ask_question");
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
  const hasInjectedTodo = mounted.tools.some((t) => t.name === "todo_write");
  const todoAllowed = deps.toolFilter ? toolFilterAllows(deps.toolFilter, "todo_write") : true;
  // Explicit durable-lesson capture (omp learn tool, local backend). The
  // workspace file must never steer the product: read_write workspaces only.
  if (deps.workspaceAccess === "read_write") {
    plugins.push({
      name: "oma-native-learn",
      tools: [createLearnTool({ workspaceRoot: deps.workspaceRoot })],
    });
  }
  const nativeTodoWanted = !hasInjectedTodo && todoAllowed;
  if (nativeTodoWanted) {
    const todoStore = createFileTodoStore(deps.workspaceRoot);
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

  let activeRun: AgentRunSnapshot<"oma"> | null = null;

  // Resolve the model display identity for a run's ref - used by the Session
  // to render the per-loop Meta (workspace/model fact line). The Session is
  // the sole Meta owner; the Run runtime never passes a meta string.
  const resolveModel = async (modelId: string): Promise<{ provider: string; id: string }> => {
    const model = await resolveModelEntry(deps.modelRuntime, modelId);
    return { provider: model.providerId, id: model.modelId };
  };

  // Summarizer: call the RUN's model through ModelRuntime with full Message[]
  // input and AbortSignal support. Same provider/credentials as the run -
  // no surprise provider switch, no catalog-first cost surprises. No
  // summaryModel config until real cost data demands one.
  const summarize: ContextSummarizer = async (messages, signal) => {
    const summaryMessages: Message[] = [
      {
        role: "system",
        text: "Summarize the following conversation messages, preserving tool calls, results, decisions and next steps.",
      },
      ...messages,
    ];
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const stream = deps.modelRuntime.stream(
      currentModel.providerId,
      currentModel.modelId,
      summaryMessages,
      { signal: combined },
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
    return text || "[empty summary]";
  };

  // ContextBudget from the RUN model's context window: compaction triggers
  // at the same threshold the real model would overflow, neither premature
  // nor too late.
  const contextBudget: ContextBudget = {
    estimate: (m) => estimateMessageTokens(m),
    limit: currentModel.contextWindow,
    triggerRatio: 0.7,
  };

  // Wall-clock cap on a single model call: a silent/stuck provider must not
  // leave the Run in `running` forever. The timeout aborts the call and the
  // Run fails (no auto-retry). Overridable via env for tests.
  const modelTimeoutMs = knobs.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const approvalDeadlineMs = knobs.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  /** Advance an async iterator, racing each chunk against the combined
   *  signal. Providers that ignore the signal (e.g. a generator sleeping
   *  forever) can no longer hold the Run hostage: abort rejects immediately
   *  instead of waiting for the provider to notice. */
  const nextBounded = async <T>(
    iter: AsyncIterator<T>,
    combined: AbortSignal,
    timeoutSignal: AbortSignal,
  ): Promise<IteratorResult<T>> => {
    if (combined.aborted) {
      throw new Error(timeoutSignal.aborted ? "model timed out" : "model call aborted");
    }
    let settled = false;
    return new Promise((resolve, reject) => {
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
    });
  };

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
  // Native-tool permission gate (ADR 0020): "deny" blocks outright; "ask"
  // routes high-risk tools through the SAME approvalHandler as plugin code
  // tools (one pipeline). "auto" (CC auto-mode alignment, 2026-09) routes
  // effect-escaping tools — bash / eval / mcp__* / plugin code tools, whose
  // reach is NOT bounded by the workspace path sandbox — through the
  // permission classifier; write/edit skip it (workspace-sandboxed, the CC
  // "working-dir edits auto-approve" precedent). Absent mode = ungated
  // (legacy standalone default, unchanged).
  const HIGH_RISK_NATIVE_TOOLS: Record<string, true> = {
    bash: true,
    eval: true,
    write: true,
    edit: true,
    create_file: true,
  };
  // Product-owned mounts (workspace-bridge: features.ts names them
  // "product-tools" / "knowledge") are consented-by-design read/context
  // surfaces with their own per-run auth — never gate them, or ask/deny
  // modes would demand a human click per history_* call.
  const PRODUCT_MOUNTED_PREFIXES = ["mcp__product-tools__", "mcp__knowledge__"];
  const isProductMounted = (toolName: string): boolean =>
    PRODUCT_MOUNTED_PREFIXES.some((p) => toolName.startsWith(p));
  const classifierGated = (toolName: string): boolean =>
    !isProductMounted(toolName) &&
    (toolName === "bash" ||
      toolName === "eval" ||
      toolName.startsWith("mcp__") ||
      pluginCodeToolNames.has(toolName));
  /** Escalated (human-reviewed) actions this Run, keyed toolName+input.
   *  A classifier block escalates ONCE per unique action; identical repeats
   *  deny silently (card-spam guard, CC's repeated-block discipline). */
  const escalatedActions = new Set<string>();
  /** User intent context for the classifier (anti-injection: user messages
   *  only — never tool results, never assistant output). */
  const USER_INTENT_SOURCES = new Set(["prompt", "steer", "follow_up"]);
  const recentUserTexts = async (): Promise<string[]> => {
    try {
      const entries = await store.readBranch(deps.runId);
      return entries
        .filter(
          (e) =>
            e.type === "message" &&
            (e as { role?: string }).role === "user" &&
            USER_INTENT_SOURCES.has((e as { source?: string }).source ?? ""),
        )
        .map((e) => ((e as { message?: { text?: string } }).message?.text ?? "").slice(0, 800))
        .filter((t) => t.length > 0)
        .slice(-5);
    } catch {
      return [];
    }
  };
  /** Auto-mode decision: hard critical-path guard → classifier → escalate
   *  the block to the human once per unique action. Throws reach the
   *  caller's fail-closed catch, never the loop's fail-open one. */
  const autoGateDecision = async (
    toolName: string,
    input: unknown,
    callId: string,
    userTexts: readonly string[],
  ): Promise<{ block: boolean; reason?: string } | undefined> => {
    // Hard circuit breaker (nothing downstream can override it,
    // not the classifier, not a human card).
    if (toolName === "bash" && isCriticalDeletion((input as { command?: string })?.command ?? "")) {
      return {
        block: true,
        reason: `${toolName}: critical-path deletion (root/top-level/home target) — re-issue with a narrower named path`,
      };
    }
    const verdict = await classifyPermissionAction({
      toolName,
      input,
      userTexts,
      stream: (messages, signal, modelIdOverride) =>
        streamModel(messages, signal, undefined, modelIdOverride),
      timeoutMs: knobs.permissionClassifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
      ...(knobs.permissionClassifierModel ? { modelId: knobs.permissionClassifierModel } : {}),
    });
    if (verdict.verdict === "allow") return undefined;
    // CC auto fallback: a block escalates to the human ONCE per unique
    // action; no approvalHandler or an already-escalated action denies
    // silently. The set is per-Run (dies with the runtime) and bounded by
    // the run timeout in the worst case.
    // ponytail: unbounded set; cap or LRU if runs ever issue thousands of
    // distinct blocked actions.
    const actionKey = `${toolName}:${JSON.stringify(input)}`;
    if (!deps.approvalHandler || escalatedActions.has(actionKey)) {
      return {
        block: true,
        reason: `${toolName}: blocked by classifier — ${verdict.reason}`,
      };
    }
    escalatedActions.add(actionKey);
    const human = await withApprovalDeadline(
      deps.approvalHandler({
        // Same key discipline as the ask gate: the card must be resolvable.
        callId: callId || `cls-${randomUUID().slice(0, 8)}`,
        toolName,
        input,
        reason: `classifier: ${verdict.reason}`,
        source: "classifier",
      }),
      approvalDeadlineMs,
    );
    if (human.decision === "deny") {
      return {
        block: true,
        reason: `${toolName}: blocked by classifier — ${verdict.reason} (human denied)`,
      };
    }
    return undefined;
  };
  /** Session permission gate factory: the main session AND every workflow
   *  subagent share one policy (critical guard, classifier, one
   *  escalatedActions set per Run) but judge against their own intent —
   *  a subagent's "user request" is the task it was assigned. */
  const makeSessionPermissionGate =
    (intentTexts: readonly string[]) =>
    async (
      toolName: string,
      input: unknown,
      callId: string,
    ): Promise<{ block: boolean; reason?: string } | undefined> => {
      if (deps.permissionMode === undefined) return undefined;
      if (deps.permissionMode === "auto") {
        if (!classifierGated(toolName)) return undefined;
        // The auto gate must be fail-CLOSED end to end: the agent loop
        // swallows gate exceptions as "no verdict" (= allow), so any
        // error in here must convert to a block, never propagate.
        try {
          return await autoGateDecision(toolName, input, callId, [
            ...intentTexts,
            ...(await recentUserTexts()),
          ]);
        } catch (err) {
          return {
            block: true,
            reason: `${toolName}: permission gate error — ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }
      const isHighRisk =
        !isProductMounted(toolName) &&
        (HIGH_RISK_NATIVE_TOOLS[toolName] === true || toolName.startsWith("mcp__"));
      if (!isHighRisk) return undefined;
      if (deps.permissionMode === "deny") {
        return { block: true, reason: `${toolName}: blocked by permissionMode=deny` };
      }
      // ask
      if (!deps.approvalHandler) {
        return {
          block: true,
          reason: `${toolName}: approval required but no pipeline configured`,
        };
      }
      // Fail-closed: an approvalHandler crash (overlay, wire error) must block
      // the tool, not fall through to the loop's catch{} = execute. This is
      // the same discipline the auto branch below/above enforces.
      const approvalInput: {
        callId: string;
        toolName: string;
        input: unknown;
        source: "permission";
        sandboxed?: boolean;
      } = {
        // The tool call's own id: the ONLY value a human card can resolve
        // against (resolve_approval / the web approval endpoint). Minting a
        // fresh one here silently breaks every approval round-trip.
        // `?? ""` is a last-resort net for callers that predate the id; the
        // auto-mode escalation below keeps its own synthetic id.
        callId: callId || `perm-${randomUUID().slice(0, 8)}`,
        toolName,
        input,
        source: "permission",
      };
      // BashSandbox design P4: bash approvals are unsandboxed fallbacks
      // until an OS sandbox is injected (only Null exists today).
      if (toolName === "bash") approvalInput.sandboxed = false;
      let verdict: { decision: string; reason?: string };
      try {
        verdict = await withApprovalDeadline(
          deps.approvalHandler(approvalInput),
          approvalDeadlineMs,
        );
      } catch (err) {
        return {
          block: true,
          reason: `${toolName}: approval pipeline error — ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (verdict.decision === "deny") {
        return {
          block: true,
          reason: `${toolName}: denied — ${verdict.reason ?? "user denied"}`,
        };
      }
      return undefined;
    };
  const permissionGate =
    deps.permissionMode === undefined ? undefined : makeSessionPermissionGate([]);

  // --tools filter also governs the subagent table: a `--tools read` Run must
  // not hand its children bash/write. Applied here (the executor receives the
  // post-filter list) and again to the main session's plugin table below.
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
    budgetGate: delegationBudgetGate,
    ...(deps.permissionMode === undefined ? {} : { makePermissionGate: makeSessionPermissionGate }),
    emit: (event) => {
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
    },
    maxConcurrent: 8,
    maxTotal: 64,
  });
  // Script runs: one batchId shared by every agent() the script spawns.
  // The vm evaluator has no fs/network; the executor enforces caps/budget.
  const runScript = async ({
    script,
    args,
  }: {
    script: string;
    args?: unknown;
  }): Promise<{ ok: boolean; totalTokens: number; value: unknown }> => {
    const batchId = `script-${crypto.randomUUID()}`;
    const results: SubagentResult[] = [];
    sessionEmit?.({
      type: "delegation_batch_started",
      batchId,
      label: "script",
      agentCount: 0,
    });
    const { value } = await evaluateOrchestrationScript({
      script,
      args,
      primitives: {
        agent: async (prompt, opts) => {
          const result = await delegationExecutor.runSubagent({
            batchId,
            agentId: randomUUID(),
            prompt,
            ...(opts?.schema ? { schema: opts.schema } : {}),
            ...(opts?.label ? { label: opts.label } : {}),
          });
          results.push(result);
          return result;
        },
        pipeline: (items, fn) => Promise.all(items.map(fn)),
      },
    });
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
    sessionEmit?.({
      type: "delegation_batch_completed",
      batchId,
      ok,
      agentCount: results.length,
      totalTokens,
    });
    return { ok, totalTokens, value };
  };
  plugins.push({
    name: "delegation-tools",
    tools: createDelegationTools({
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
        // read_only workspaces have no local agent definitions — builtins only.
        if (deps.workspaceAccess !== "read_write") return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma", "agents", `${name}.md`)).text();
        } catch {
          return null;
        }
      },
    }),
  });
  plugins.push({
    name: "orchestrate-tool",
    tools: createOrchestrateTool({
      runScript,
      writeScript: (name, content) => {
        // The name is model-supplied: never treat it as a path segment
        // (a "../" escape would write outside the workspace).
        if (!isValidWorkflowName(name)) {
          throw new Error(`invalid workflow name (allowed: [a-z0-9-], max 64): ${name}`);
        }
        if (deps.workspaceAccess !== "read_write") {
          throw new Error("workflow scripts cannot be saved in a read_only workspace");
        }
        const dir = join(deps.workspaceRoot, ".oma/workflow");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.js`), content);
      },
      readScript: async (name) => {
        if (!isValidWorkflowName(name)) return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma/workflow", `${name}.js`)).text();
        } catch {
          return null;
        }
      },
    }),
  });
  plugins.push({
    name: "hub-tool",
    tools: createHubTool({
      scope,
      list: (s) => registry.listEntries(s),
      get: (id) => registry.getEntry(id),
      wait: (o) => registry.waitEntries(o),
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
    }),
  });
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
    ...(permissionGate ? { permissionGate } : {}),
  });

  // Bind the plugin runtime's emit to the session's emit (two-phase init).
  sessionEmit = (event) => session.emit(event);

  return {
    runId: deps.runId,
    store,
    knobs,
    session,
    mcpMountReports: mounted.reports,
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
      if (!deps.registry) registry.clearAll();
      // Tear down mounted MCP clients so no child process or connection
      // outlives the Run. Each close is BOUNDED: a stuck transport (e.g. an
      // SSE socket that never answers close) must not wedge the child.
      const closeWithTimeout = (p: Promise<unknown>): Promise<unknown> =>
        Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
      const closePromises: Promise<unknown>[] = [];
      closePromises.push(closeWithTimeout(closeMounted()));
      closePromises.push(closeWithTimeout(store.close()));
      await Promise.allSettled(closePromises);
    },
  };
}

export type { AgentRunSnapshot, PluginTool, ProjectedHistoryItem };
