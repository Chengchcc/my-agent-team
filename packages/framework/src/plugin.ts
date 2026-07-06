import type { Tool, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { Checkpointer } from "./checkpointer.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentEvent } from "./create-agent.js";
import type { Logger } from "./logger.js";
import type { RunSpan } from "./trace.js";

/** M14.6: Stop-gate verdict. continue=true means "veto stop, keep running with reason as input". */
export type StopDecision = { continue: true; reason: string } | { continue: false };

/** Hook execution context. `Ctx` is the per-run data shape — set via
 *  `AgentSession.setData()`, read by plugins from `ctx.data`.
 *  Defaults to `Record<string, unknown>` for sessions without typed context. */
export interface HookContext<Ctx = Record<string, unknown>> {
  sessionId: string;
  span?: RunSpan;
  signal?: AbortSignal;
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  emit?(event: AgentEvent): void;
  /** Per-run typed data. Set via `AgentSession.setData(value)`, cleared after each run. */
  data?: Ctx;
}

export interface PluginHooks<Ctx = Record<string, unknown>> {
  beforeRun?(ctx: HookContext<Ctx>, messages: readonly Message[]): Message[] | Promise<Message[]>;
  beforeModel?(ctx: HookContext<Ctx>, messages: readonly Message[]): Message[] | Promise<Message[]>;
  afterModel?(ctx: HookContext<Ctx>, messages: readonly Message[]): void | Promise<void>;
  beforeTool?(
    ctx: HookContext<Ctx>,
    call: ToolUseBlock,
    messages: readonly Message[],
  ):
    | { skip?: boolean; input?: unknown; result?: string; isError?: boolean }
    | undefined
    | Promise<{ skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined>;
  afterTool?(
    ctx: HookContext<Ctx>,
    call: ToolUseBlock,
    result: ToolResultBlock,
    messages: readonly Message[],
  ): void | Promise<void>;
  beforeStop?(
    ctx: HookContext<Ctx>,
    messages: readonly Message[],
  ): StopDecision | undefined | Promise<StopDecision | undefined>;
}

export interface Plugin<Ctx = Record<string, unknown>> {
  readonly name: string;
  readonly hooks: PluginHooks<Ctx>;
  readonly tools?: readonly Tool[];
}

export function definePlugin<Ctx = Record<string, unknown>>(definition: {
  name: string;
  hooks: PluginHooks<Ctx>;
  tools?: readonly Tool[];
}): Plugin<Ctx> {
  return { name: definition.name, hooks: definition.hooks, tools: definition.tools };
}

export function validatePlugins<Ctx = Record<string, unknown>>(
  plugins: readonly Plugin<Ctx>[],
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
