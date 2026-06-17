import type { AIMessageChunk, ContentBlock, ToolUseBlock } from "@my-agent-team/core";
import { collectStream, finalizeToolUseInputs, mergeChunkIntoBlocks } from "@my-agent-team/core";
import type {
  Message,
  MessageRevision,
  MessageState,
  MessageToolState,
} from "@my-agent-team/message";
import { assistantMessageId } from "@my-agent-team/message";
import type { AgentEvent } from "./agent-event.js";
import type { AgentRuntime } from "./agent-options.js";
import { executeOne } from "./execute-one.js";
import { wrapToolResult } from "./plugin-runner.js";

// ─── Pure helpers ──────────────────────────────────────────────

export function buildAssistantRevision(
  runId: string,
  ordinal: number,
  state: MessageState,
  blocks: ContentBlock[],
  tools: MessageToolState[],
): MessageRevision {
  return {
    messageId: assistantMessageId(runId, ordinal),
    role: "assistant",
    state,
    blocks: blocks.slice(),
    tools: tools.length > 0 ? tools.map((t) => ({ ...t })) : undefined,
    runId,
    visibility: "conversation",
    updatedAt: Date.now(),
  };
}

/** Extract tool states from tool_use blocks (all "running" initially). */
export function extractToolStates(blocks: ContentBlock[]): MessageToolState[] {
  return blocks
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, state: "running" as const }));
}

// ─── runLoop (extracted from createAgentInternal) ───────────────

export async function* runLoop(
  rt: AgentRuntime,
  opts: { signal?: AbortSignal; maxSteps: number; stream?: boolean; maxForceContinues?: number },
): AsyncGenerator<AgentEvent> {
  let forceContinues = 0;
  const maxForce = opts.maxForceContinues ?? 3;
  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) {
      // M17.2 fix: mark remaining running tools as error, emit with accumulated blocks
      markRunningToolsAsError(rt);
      yield {
        type: "message",
        payload: {
          ...buildAssistantRevision(rt.runId, 0, "error", rt.assistantBlocks, rt.toolStates),
          error: { message: "Run aborted" },
        },
      };
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "run_end",
        reason: "aborted",
        ts: Date.now(),
      });
      return;
    }

    const shaped = await rt.contextManager.shape(
      { threadId: rt.thread.id, signal: opts.signal, logger: rt.logger, model: rt.model },
      rt.thread.messages,
    );
    const finalMsgs = await rt.plugins.fireBeforeModel(shaped);

    await rt.checkpointer.appendEvent?.(rt.thread.id, {
      type: "model_start",
      messageCount: finalMsgs.length,
      ts: Date.now(),
    });

    const llmStart = Date.now();
    let ttftMs: number | undefined;
    let stopReason: string | undefined;

    const modelStream = rt.model.stream(finalMsgs, { signal: opts.signal, tools: rt.tools });
    let blocks: ContentBlock[];
    let usage: AIMessageChunk["usage"];

    if (opts.stream) {
      blocks = [];
      const partialJson = new Map<string, string>();
      for await (const chunk of modelStream) {
        if (chunk.delta?.type === "text" && ttftMs === undefined) {
          ttftMs = Date.now() - llmStart;
        }
        mergeChunkIntoBlocks(blocks, partialJson, chunk);
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.stopReason) stopReason = chunk.stopReason;
        if (chunk.done) break;
      }
      finalizeToolUseInputs(blocks, partialJson);
    } else {
      const collected = await collectStream(modelStream);
      blocks = collected.blocks;
      usage = collected.usage;
      if (collected.stopReason) stopReason = collected.stopReason;
    }

    await rt.checkpointer.appendEvent?.(rt.thread.id, {
      type: "model_end",
      blocks: blocks.slice(),
      usage,
      ts: Date.now(),
    });

    yield {
      type: "llm_call",
      payload: {
        step,
        model: rt.model.id ?? "unknown",
        usage: {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheCreate: usage?.cacheCreate,
          cacheRead: usage?.cacheRead,
        },
        latencyMs: Date.now() - llmStart,
        ttftMs,
        stopReason,
      },
    };

    if (blocks.length === 0) {
      yield {
        type: "message",
        payload: buildAssistantRevision(rt.runId, 0, "done", rt.assistantBlocks, rt.toolStates),
      };
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "run_end",
        reason: "complete",
        ts: Date.now(),
      });
      return;
    }

    // Push assistant message to thread (internal, for LLM context)
    const assistantMsg: Message = { role: "assistant", blocks: blocks.slice() };
    rt.thread.messages.push(assistantMsg);
    await rt.plugins.fireAfterModel(rt.thread.messages);

    // M17.2 fix: Accumulate blocks for full-run visibility
    rt.assistantBlocks.push(...blocks);

    // Extract and merge tool states
    const newTools = extractToolStates(blocks);
    for (const nt of newTools) {
      const existing = rt.toolStates.findIndex((t) => t.id === nt.id);
      if (existing >= 0) rt.toolStates[existing] = nt;
      else rt.toolStates.push(nt);
    }

    // Emit message revision with accumulated blocks
    yield {
      type: "message",
      payload: buildAssistantRevision(rt.runId, 0, "streaming", rt.assistantBlocks, rt.toolStates),
    };

    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (maxForce > 0 && forceContinues < maxForce) {
        const verdict = await rt.plugins.fireBeforeStop(rt.thread.messages);
        for (const ev of rt.pendingEvents.splice(0)) yield ev;
        if (verdict?.continue) {
          forceContinues++;
          rt.thread.messages.push({ role: "user", text: verdict.reason });
          await rt.checkpointer.appendEvent?.(rt.thread.id, {
            type: "force_continue",
            reason: verdict.reason,
            attempt: forceContinues,
            ts: Date.now(),
          });
          await rt.save(rt.thread.messages);
          continue;
        }
      }
      await rt.save(rt.thread.messages);
      yield {
        type: "message",
        payload: buildAssistantRevision(rt.runId, 0, "done", rt.assistantBlocks, rt.toolStates),
      };
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "run_end",
        reason: "complete",
        ts: Date.now(),
      });
      return;
    }

    // Execute tools — executeOne updates rt.toolStates in-place
    let interrupted = false;
    for (let i = 0; i < toolUses.length; i++) {
      const call = toolUses[i]!;
      interrupted = yield* executeOne(rt, call, opts, step);
      if (interrupted) {
        for (let j = i; j < toolUses.length; j++) {
          const remaining = toolUses[j]!;
          rt.thread.messages.push({
            role: "user",
            blocks: [wrapToolResult(remaining, { content: "Interrupted", isError: true })],
          });
          updateToolState(rt, remaining.id, "error", true);
        }
        yield {
          type: "message",
          payload: buildAssistantRevision(
            rt.runId,
            0,
            "waiting",
            rt.assistantBlocks,
            rt.toolStates,
          ),
        };
        await rt.save(rt.thread.messages);
        return;
      }
    }

    // After all tools in this step completed, emit updated revision
    yield {
      type: "message",
      payload: buildAssistantRevision(rt.runId, 0, "streaming", rt.assistantBlocks, rt.toolStates),
    };
  }

  // M17.2 fix: maxSteps reached — mark remaining running tools as error
  markRunningToolsAsError(rt);
  yield {
    type: "message",
    payload: {
      ...buildAssistantRevision(rt.runId, 0, "error", rt.assistantBlocks, rt.toolStates),
      error: { message: "Max steps reached" },
    },
  };
  await rt.checkpointer.appendEvent?.(rt.thread.id, {
    type: "run_end",
    reason: "maxSteps",
    ts: Date.now(),
  });
}

/** Mark any still-running tools as error (used at abort/maxSteps boundaries). */
function markRunningToolsAsError(rt: AgentRuntime): void {
  for (const ts of rt.toolStates) {
    if (ts.state === "running") {
      ts.state = "error";
      ts.isError = true;
    }
  }
}

/** Helper to update a single tool's state. */
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
