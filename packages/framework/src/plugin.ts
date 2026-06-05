import type { Message, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";

export interface HookContext {
  threadId: string;
  signal?: AbortSignal;
}

export interface PluginHooks {
  beforeModel?(ctx: HookContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
  afterModel?(ctx: HookContext, messages: readonly Message[]): void | Promise<void>;
  beforeTool?(ctx: HookContext, call: ToolUseBlock, messages: readonly Message[]):
    | { skip?: boolean; input?: unknown; result?: string }
    | void
    | Promise<{ skip?: boolean; input?: unknown; result?: string } | void>;
  afterTool?(ctx: HookContext, call: ToolUseBlock, result: ToolResultBlock, messages: readonly Message[]):
    | void
    | Promise<void>;
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
