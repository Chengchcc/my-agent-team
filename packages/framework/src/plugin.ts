import type { Message, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
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
}

export function definePlugin(definition: { name: string; hooks: PluginHooks }): Plugin {
  return {
    name: definition.name,
    hooks: definition.hooks,
  };
}
