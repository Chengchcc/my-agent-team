import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { HookContext, Plugin } from "@my-agent-team/framework";
import { definePlugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { AgentContext, AgentHooks } from "./agent-hooks.js";

export function createHookPlugin(hooks: AgentHooks, agentCtx: AgentContext): Plugin {
  const fw: Record<string, unknown> = {};

  if (hooks["before:model"]) {
    const fn = hooks["before:model"];
    fw.beforeModel = (ctx: HookContext, msgs: readonly Message[]) => fn(agentCtx, msgs);
  }

  if (hooks["after:model"]) {
    const fn = hooks["after:model"];
    fw.afterModel = (ctx: HookContext, msgs: readonly Message[]) =>
      fn(agentCtx, msgs, { input: 0, output: 0 });
  }

  if (hooks["before:tool"]) {
    const fn = hooks["before:tool"];
    fw.beforeTool = (_ctx: HookContext, call: ToolUseBlock, _msgs: readonly Message[]) =>
      fn(agentCtx, { id: call.id, name: call.name, input: call.input });
  }

  if (hooks["after:tool"]) {
    const fn = hooks["after:tool"];
    fw.afterTool = (
      _ctx: HookContext,
      call: ToolUseBlock,
      result: ToolResultBlock,
      _msgs: readonly Message[],
    ) =>
      fn(
        agentCtx,
        { id: call.id, name: call.name, input: call.input },
        {
          content: String(result.content ?? ""),
          isError: result.is_error,
        },
      );
  }

  if (hooks["before:stop"]) {
    const fn = hooks["before:stop"];
    fw.beforeStop = (_ctx: HookContext, msgs: readonly Message[]) => fn(agentCtx, msgs);
  }

  return definePlugin({ name: "agent-hooks", hooks: fw as Plugin["hooks"] });
}
