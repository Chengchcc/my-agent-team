import { Agent } from "./agent.js";
import type { AgentHooks } from "./agent-hooks.js";
import type { AgentConfig } from "./agent-options.js";
import type {
  AgentExtension,
  AgentExtensionFactory,
  AgentScope,
  ResolvedExtension,
} from "./extension-host.js";
import { composeExtensions, ExtensionHost } from "./extension-host.js";
import type { ChatModel, Tool } from "./framework-adapter.js";
import type { ModelRef, ModelRuntime, ResolvedModel } from "./model-runtime.js";
import { resolveModel } from "./model-runtime.js";
import type { SessionManager } from "./session-manager.js";

// ── Public input type ──

export interface CreateAgentSessionInput {
  scope: AgentScope;

  /** Already-resolved ChatModel, or a ModelRef string requiring a ModelRuntime. */
  model: ChatModel | ModelRef;

  /** Required when model is a ModelRef string. */
  modelRuntime?: ModelRuntime;

  /** Capability-backed extension factories — resolved per Agent scope. */
  extensions?: readonly AgentExtensionFactory[];

  /** Base tools available to all extensions (e.g. conversation tools). */
  tools?: readonly Tool[];

  /** Base system prompt injected before capability prompts. */
  systemPrompt?: string;

  /** Session persistence — when provided, sessions are reused via open/create. */
  sessionManager?: SessionManager;

  /** Optional: Agent lifecycle hooks applied after composed hooks. */
  hooks?: AgentHooks;

  /** Context manager pipeline. */
  contextManager?: AgentConfig["contextManager"];

  /** Logger. */
  logger?: AgentConfig["logger"];

  /** Retry settings. */
  retry?: AgentConfig["retry"];

  /** Compaction settings. */
  compaction?: AgentConfig["compaction"];
}

// ── Implementation ──

async function resolveInputModel(
  input: CreateAgentSessionInput["model"],
  runtime?: ModelRuntime,
): Promise<ResolvedModel> {
  return resolveModel(input, runtime);
}

async function resolveExtensions(
  factories: readonly AgentExtensionFactory[],
  scope: AgentScope,
): Promise<readonly ResolvedExtension[]> {
  const host = new ExtensionHost(factories);
  return host.resolve(scope);
}

/**
 * Create an Agent session.
 *
 * Two model input modes:
 * - ChatModel: direct (test, custom)
 * - ModelRef string: requires modelRuntime (production)
 *
 * Extensions are resolved per Agent scope and composed in registration order.
 */
export async function createAgentSession(input: CreateAgentSessionInput): Promise<Agent> {
  const resolvedModel = await resolveInputModel(input.model, input.modelRuntime);

  const resolvedExtensions = input.extensions
    ? await resolveExtensions(input.extensions, input.scope)
    : [];

  const composed: AgentExtension = composeExtensions({
    resolved: resolvedExtensions,
    baseTools: input.tools ?? [],
    baseSystemPrompt: input.systemPrompt,
  });

  const hooks: AgentHooks = {
    ...composed.hooks,
    ...input.hooks,
  };

  const systemPrompt =
    [input.systemPrompt, composed.systemPrompt].filter(Boolean).join("\n\n") || undefined;

  const agentConfig: AgentConfig = {
    model: resolvedModel.chatModel,
    tools: composed.tools ? [...composed.tools] : input.tools ? [...input.tools] : undefined,
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    systemPrompt,
    contextManager: input.contextManager,
    logger: input.logger,
    retry: input.retry,
    compaction: input.compaction,
  };

  if (input.sessionManager) {
    const sid = input.scope.sessionId;
    return sid
      ? input.sessionManager.open(sid, agentConfig)
      : input.sessionManager.create(agentConfig);
  }

  return new Agent({
    ...agentConfig,
    sessionId: input.scope.sessionId,
  });
}
