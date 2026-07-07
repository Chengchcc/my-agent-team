import type { Tool, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { Checkpointer } from "./checkpointer.js";
import type { ContextStore } from "./context.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentEvent } from "./create-agent.js";
import type { Logger } from "./logger.js";
import type { RunSpan } from "./trace.js";

/** M14.6: Stop-gate verdict. continue=true means "veto stop, keep running with reason as input". */
export type StopDecision = { continue: true; reason: string } | { continue: false };

/** Hook execution context. Per-run data lives in `context` (a multi-key store);
 *  plugins read via `MyKey.get(ctx)`, callers write via `session.setContext(key, value)`. */
export interface HookContext {
  sessionId: string;
  span?: RunSpan;
  signal?: AbortSignal;
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  emit?(event: AgentEvent): void;
  /** Per-run data store. Always present (may be empty). Cleared after each run. */
  context: ContextStore;
}

export interface PluginHooks {
  beforeRun?(ctx: HookContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
  beforeModel?(ctx: HookContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
  afterModel?(ctx: HookContext, messages: readonly Message[]): void | Promise<void>;
  beforeTool?(
    ctx: HookContext,
    call: ToolUseBlock,
    messages: readonly Message[],
  ):
    | { skip?: boolean; input?: unknown; result?: string; isError?: boolean }
    | undefined
    | Promise<{ skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined>;
  afterTool?(
    ctx: HookContext,
    call: ToolUseBlock,
    result: ToolResultBlock,
    messages: readonly Message[],
  ): void | Promise<void>;
  beforeStop?(
    ctx: HookContext,
    messages: readonly Message[],
  ): StopDecision | undefined | Promise<StopDecision | undefined>;
}

export interface Plugin {
  readonly name: string;
  readonly hooks: PluginHooks;
  readonly tools?: readonly Tool[];
}

export function definePlugin(definition: {
  name: string;
  hooks: PluginHooks;
  tools?: readonly Tool[];
}): Plugin {
  return { name: definition.name, hooks: definition.hooks, tools: definition.tools };
}

export function validatePlugins(
  plugins: readonly Plugin[],
  configTools: readonly Tool[] = [],
): readonly Tool[] {
  const seen = new Map<string, string>();
  for (const t of configTools) seen.set(t.name, "config.tools");
  for (const p of plugins) {
    for (const t of p.tools ?? []) {
      const prev = seen.get(t.name);
      if (prev) {
        throw new Error(
          `Tool name collision: '${t.name}' declared by both '${prev}' and plugin '${p.name}'`,
        );
      }
      seen.set(t.name, `plugin:${p.name}`);
    }
  }
  return [...configTools, ...plugins.flatMap((p) => p.tools ?? [])];
}
