import type { Message, MessageRole } from "@my-agent-team/message";
import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { HookContext, Plugin, StopDecision } from "./plugin.js";
import type { Logger } from "./logger.js";
import type { PluginRunner } from "./agent-options.js";

// ─── Pure helpers ──────────────────────────────────────────────

export function wrapToolResult(
  call: ToolUseBlock,
  result: { content: string; isError?: boolean },
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: result.content,
    ...(result.isError !== undefined ? { is_error: result.isError } : {}),
  };
}

// ─── Plugin runner (extracted fire* helpers) ───────────────────

export function createPluginRunner(
  plugins: readonly Plugin[],
  ctx: HookContext,
  logger: Logger,
): PluginRunner {
  async function eachPlugin(hookName: string, fn: (p: Plugin) => Promise<void>): Promise<void> {
    for (const p of plugins) {
      try {
        await fn(p);
      } catch (err) {
        logger.warn(`${hookName} ${p.name}`, err);
      }
    }
  }

  return {
    async fireBeforeModel(msgs: Message[]): Promise<Message[]> {
      let current = msgs;
      await eachPlugin("beforeModel", async (p) => {
        if (p.hooks.beforeModel) {
          const result = await p.hooks.beforeModel(ctx, current);
          if (result !== undefined) current = result;
        }
      });
      return current;
    },

    async fireAfterModel(msgs): Promise<void> {
      await eachPlugin("afterModel", async (p) => {
        if (p.hooks.afterModel) await p.hooks.afterModel(ctx, msgs);
      });
    },

    async fireBeforeTool(call, msgs) {
      let decision:
        | { skip?: boolean; input?: unknown; result?: string; isError?: boolean }
        | undefined;
      await eachPlugin("beforeTool", async (p) => {
        if (p.hooks.beforeTool) {
          const d = await p.hooks.beforeTool(ctx, call, msgs);
          if (d) {
            if (d.skip)
              decision = { ...decision, skip: true, result: d.result, isError: d.isError };
            if (d.input !== undefined) decision = { ...decision, input: d.input };
          }
        }
      });
      return decision;
    },

    async fireAfterTool(call, result, msgs): Promise<void> {
      await eachPlugin("afterTool", async (p) => {
        if (p.hooks.afterTool) await p.hooks.afterTool(ctx, call, result, msgs);
      });
    },

    async fireBeforeRun(msgs): Promise<readonly Message[]> {
      let current = msgs;
      await eachPlugin("beforeRun", async (p) => {
        if (p.hooks.beforeRun) {
          const result = await p.hooks.beforeRun(ctx, current);
          if (result !== undefined) current = result;
        }
      });
      return current;
    },

    async fireBeforeStop(msgs) {
      const reasons: string[] = [];
      await eachPlugin("beforeStop", async (p) => {
        if (p.hooks.beforeStop) {
          const d = await p.hooks.beforeStop(ctx, msgs);
          if (d?.continue) reasons.push(d.reason);
        }
      });
      return reasons.length > 0 ? { continue: true, reason: reasons.join("\n\n") } : undefined;
    },
  };
}
