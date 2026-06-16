import type { Tool, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { Checkpointer } from "./checkpointer.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentEvent } from "./create-agent.js";
import type { Logger } from "./logger.js";

/** M14.6: Stop-gate verdict. continue=true means "veto stop, keep running with reason as input". */
export type StopDecision = { continue: true; reason: string } | { continue: false };

export interface HookContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  /** M14.6: Optional event emitter for plugins to push AgentEvents (e.g. todo_update).
   *  Only carries events — never exposes model. Set by framework before each hook fire. */
  emit?(event: AgentEvent): void;
}

export interface PluginHooks {
  /** M14.6: Pre-loop hook, fires once per run() after user message is pushed.
   *  Transformer — returned messages replace thread.messages. Used for seeding todo plan. */
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
  /** M14.6: Fires when model returns no tool_use and the loop is about to end.
   *  Returns StopDecision to veto stop and force-continue, or undefined/{continue:false} to allow stop.
   *  Plugin should only do deterministic checks here (no LLM calls). */
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
  return {
    name: definition.name,
    hooks: definition.hooks,
    tools: definition.tools,
  };
}

export function validatePlugins(
  plugins: readonly Plugin[],
  configTools: readonly Tool[] = [],
): readonly Tool[] {
  const seen = new Map<string, string>(); // name → source
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
