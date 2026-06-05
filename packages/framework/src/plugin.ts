import type { Message, Tool, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Checkpointer } from "./checkpointer.js";
import type { ContextManager } from "./context-manager.js";
import type { Logger } from "./logger.js";

export interface HookContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
}

export interface PluginHooks {
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
