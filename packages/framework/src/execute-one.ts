import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { AgentEvent } from "./agent-event.js";
import type { AgentRuntime } from "./agent-options.js";
import { InterruptSignal } from "./checkpointer.js";
import { wrapToolResult } from "./plugin-runner.js";

// ─── executeOne (extracted from createAgentInternal) ────────────

export async function* executeOne(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): AsyncGenerator<AgentEvent, boolean> {
  await rt.checkpointer.appendEvent?.(rt.thread.id, { type: "tool_start", call, ts: Date.now() });
  // M17.2: tool_start/tool_end no longer top-level events — tool state lives in
  // MessageRevision.tools[] (updated below). Render-layer reads tools[]; observability
  // reads tool_call.

  const toolStart = Date.now();
  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    rt.thread.messages.push({ role: "user", blocks: [r] });
    await rt.save(rt.thread.messages);
    yield {
      type: "tool_call",
      payload: {
        step,
        id: call.id,
        name: call.name,
        latencyMs: Date.now() - toolStart,
        isError: r.is_error === true,
      },
    };
    // Update tool state in the running revision
    updateToolState(rt, call.id, r.is_error === true ? "error" : "done", r.is_error === true);
    return false;
  }

  let resultBlock: ToolResultBlock;
  try {
    const input = decision?.input ?? call.input;
    const tool = rt.toolMap.get(call.name);
    if (!tool) {
      resultBlock = wrapToolResult(call, {
        content: `Tool not found: ${call.name}`,
        isError: true,
      });
    } else {
      resultBlock = wrapToolResult(call, await tool.execute(input, opts.signal));
    }
  } catch (err) {
    if (err instanceof InterruptSignal) {
      await rt.save(rt.thread.messages);
      if (!rt.checkpointer.saveInterrupt) {
        throw new Error(
          "Tool requested interrupt but checkpointer does not support it. " +
            "Use a checkpointer that implements saveInterrupt/consumeInterrupt.",
          { cause: err },
        );
      }
      await rt.checkpointer.saveInterrupt(rt.thread.id, {
        pendingTool: { call, reason: err.reason },
        ts: Date.now(),
        meta: err.meta,
      });
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "interrupt",
        pendingTool: call,
        reason: err.reason,
        ts: Date.now(),
      });
      yield {
        type: "tool_call",
        payload: {
          step,
          id: call.id,
          name: call.name,
          latencyMs: Date.now() - toolStart,
          isError: true,
        },
      };
      // Update tool state to error for interrupt
      updateToolState(rt, call.id, "error", true);
      yield {
        type: "interrupted",
        payload: { pendingTool: call, reason: err.reason, meta: err.meta },
      };
      return true;
    }
    resultBlock = wrapToolResult(call, {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }

  rt.thread.messages.push({ role: "user", blocks: [resultBlock] });
  await rt.plugins.fireAfterTool(call, resultBlock, rt.thread.messages);
  for (const ev of rt.pendingEvents.splice(0)) yield ev;
  await rt.checkpointer.appendEvent?.(rt.thread.id, {
    type: "tool_end",
    result: resultBlock,
    durationMs: Date.now() - toolStart,
    ts: Date.now(),
  });
  yield {
    type: "tool_call",
    payload: {
      step,
      id: call.id,
      name: call.name,
      latencyMs: Date.now() - toolStart,
      isError: resultBlock.is_error === true,
    },
  };
  // Update tool state in the running revision
  updateToolState(
    rt,
    call.id,
    resultBlock.is_error === true ? "error" : "done",
    resultBlock.is_error === true,
  );
  await rt.save(rt.thread.messages);
  return false;
}

/** M17.2 fix: shared helper to eliminate repeated tool-state update pattern. */
function updateToolState(
  rt: AgentRuntime,
  toolId: string,
  state: "done" | "error",
  isError: boolean,
): void {
  const ts = rt.toolStates.find((t) => t.id === toolId);
  if (ts) {
    ts.state = state;
    ts.isError = isError;
  }
}

/** Non-generator variant of executeOne for use inside Promise.all in batch execution.
 *  Returns results directly instead of yielding — caller handles ordering and yielding. */
export interface RunOneResult {
  resultBlock: ToolResultBlock;
  events: AgentEvent[];
  interrupted: boolean;
}

export async function runOneCollect(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): Promise<RunOneResult> {
  const events: AgentEvent[] = [];
  const toolStart = Date.now();

  await rt.checkpointer.appendEvent?.(rt.thread.id, { type: "tool_start", call, ts: Date.now() });

  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    rt.thread.messages.push({ role: "user", blocks: [r] });
    await rt.save(rt.thread.messages);
    events.push({
      type: "tool_call",
      payload: {
        step,
        id: call.id,
        name: call.name,
        latencyMs: Date.now() - toolStart,
        isError: r.is_error === true,
      },
    });
    updateToolState(rt, call.id, r.is_error === true ? "error" : "done", r.is_error === true);
    return { resultBlock: r, events, interrupted: false };
  }

  let resultBlock: ToolResultBlock;
  try {
    const input = decision?.input ?? call.input;
    const tool = rt.toolMap.get(call.name);
    if (!tool) {
      resultBlock = wrapToolResult(call, {
        content: `Tool not found: ${call.name}`,
        isError: true,
      });
    } else {
      resultBlock = wrapToolResult(call, await tool.execute(input, opts.signal));
    }
  } catch (err) {
    if (err instanceof InterruptSignal) {
      await rt.save(rt.thread.messages);
      if (!rt.checkpointer.saveInterrupt) {
        throw new Error(
          "Tool requested interrupt but checkpointer does not support it. " +
            "Use a checkpointer that implements saveInterrupt/consumeInterrupt.",
          { cause: err },
        );
      }
      await rt.checkpointer.saveInterrupt(rt.thread.id, {
        pendingTool: { call, reason: err.reason },
        ts: Date.now(),
        meta: err.meta,
      });
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "interrupt",
        pendingTool: call,
        reason: err.reason,
        ts: Date.now(),
      });
      events.push({
        type: "tool_call",
        payload: {
          step,
          id: call.id,
          name: call.name,
          latencyMs: Date.now() - toolStart,
          isError: true,
        },
      });
      updateToolState(rt, call.id, "error", true);
      events.push({
        type: "interrupted",
        payload: { pendingTool: call, reason: err.reason, meta: err.meta },
      });
      return {
        resultBlock: wrapToolResult(call, { content: "Interrupted", isError: true }),
        events,
        interrupted: true,
      };
    }
    resultBlock = wrapToolResult(call, {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }

  rt.thread.messages.push({ role: "user", blocks: [resultBlock] });
  await rt.plugins.fireAfterTool(call, resultBlock, rt.thread.messages);
  for (const ev of rt.pendingEvents.splice(0)) events.push(ev);
  await rt.checkpointer.appendEvent?.(rt.thread.id, {
    type: "tool_end",
    result: resultBlock,
    durationMs: Date.now() - toolStart,
    ts: Date.now(),
  });
  events.push({
    type: "tool_call",
    payload: {
      step,
      id: call.id,
      name: call.name,
      latencyMs: Date.now() - toolStart,
      isError: resultBlock.is_error === true,
    },
  });
  updateToolState(
    rt,
    call.id,
    resultBlock.is_error === true ? "error" : "done",
    resultBlock.is_error === true,
  );
  await rt.save(rt.thread.messages);
  return { resultBlock, events, interrupted: false };
}
