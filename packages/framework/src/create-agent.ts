import type { AIMessageChunk, ChatModel, ContentBlock, Message, Tool, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import { collectStream, mergeChunkIntoBlocks, finalizeToolUseInputs } from "@my-agent-team/core";
import { type Checkpointer, InterruptSignal, validateCheckpointer } from "./checkpointer.js";
import { inMemoryCheckpointer } from "./checkpointers/in-memory.js";
import type { ContextManager } from "./context-manager.js";
import { passthroughContextManager } from "./context-managers/passthrough.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { HookContext, Plugin } from "./plugin.js";
import { validatePlugins } from "./plugin.js";
import { createThread, type Thread } from "./thread.js";

export interface Interrupt {
  pendingTool?: ToolUseBlock; // absent for liveness interrupts (M11)
  reason: string;
  meta?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "message"; payload: Message }
  | { type: "interrupted"; payload: Interrupt }
  | { type: "error"; payload: { message: string; stack?: string } }
  | { type: "text_delta"; payload: { blockIndex: number; text: string } };

export interface ResumeCommand {
  approved: boolean;
  message?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  /** When true, text_delta events are yielded for each text chunk before the full message. Default false. */
  stream?: boolean;
}

export interface Agent {
  readonly thread: Thread;
  run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  resume(
    command: ResumeCommand,
    opts?: AgentRunOptions,
  ): AsyncIterable<AgentEvent>;
  fork(messages?: Message[], id?: string): Agent;
}

export interface AgentConfig {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;
  threadId?: string;
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const threadId = config.threadId ?? crypto.randomUUID();
  const checkpointer = config.checkpointer ?? inMemoryCheckpointer();
  validateCheckpointer(checkpointer);

  let messages: Message[] = [];
  const loaded = await checkpointer.load(threadId);
  if (loaded) messages = loaded;

  return createAgentInternal({
    ...config,
    checkpointer,
    threadId,
    _initialMessages: messages,
  });
}

function createAgentInternal(
  config: AgentConfig & {
    _initialMessages: Message[];
    threadId: string;
    checkpointer: Checkpointer;
  },
): Agent {
  const thread = createThread(config._initialMessages, config.threadId);
  const plugins = [...(config.plugins ?? [])];
  const tools = validatePlugins(plugins, config.tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const systemPrompt = config.systemPrompt;
  const checkpointer = config.checkpointer;
  const contextManager = config.contextManager ?? passthroughContextManager();
  const logger = config.logger ?? consoleLogger({ level: "info" });
  const model = config.model;
  let running = false;

  const save = async (msgs: Message[]) => {
    try {
      await checkpointer.save(thread.id, msgs);
    } catch (err) {
      logger.warn(`checkpointer.save ${thread.id}`, err);
    }
  };

  const ctx: HookContext = {
    threadId: thread.id,
    signal: undefined,
    logger,
    checkpointer,
    contextManager,
  };

  async function fireBeforeModel(msgs: Message[]): Promise<Message[]> {
    let current = msgs;
    for (const p of plugins) {
      if (p.hooks.beforeModel) {
        // M2: isolate plugin errors so one bad plugin doesn't break the chain
        try {
          const result = await p.hooks.beforeModel(ctx, current);
          current = result ?? current;
        } catch (err) {
          logger.warn(`beforeModel ${p.name}`, err);
        }
      }
    }
    return current;
  }

  async function fireAfterModel(msgs: readonly Message[]): Promise<void> {
    for (const p of plugins) {
      if (p.hooks.afterModel) {
        try {
          await p.hooks.afterModel(ctx, msgs);
        } catch (err) {
          logger.warn(`afterModel ${p.name}`, err);
        }
      }
    }
  }

  async function fireBeforeTool(
    call: ToolUseBlock,
    msgs: readonly Message[],
  ): Promise<{ skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined> {
    let decision:
      | { skip?: boolean; input?: unknown; result?: string; isError?: boolean }
      | undefined;
    for (const p of plugins) {
      if (p.hooks.beforeTool) {
        // M2: isolate plugin errors
        try {
          const d = await p.hooks.beforeTool(ctx, call, msgs);
          if (d) {
            if (d.skip)
              decision = { ...decision, skip: true, result: d.result, isError: d.isError };
            if (d.input !== undefined) decision = { ...decision, input: d.input };
          }
        } catch (err) {
          logger.warn(`beforeTool ${p.name}`, err);
        }
      }
    }
    return decision;
  }

  async function fireAfterTool(
    call: ToolUseBlock,
    result: ToolResultBlock,
    msgs: readonly Message[],
  ): Promise<void> {
    for (const p of plugins) {
      if (p.hooks.afterTool) {
        try {
          await p.hooks.afterTool(ctx, call, result, msgs);
        } catch (err) {
          logger.warn(`afterTool ${p.name}`, err);
        }
      }
    }
  }

  function wrapToolResult(
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

  async function* executeOne(
    call: ToolUseBlock,
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent, boolean> {
    await checkpointer.appendEvent?.(thread.id, {
      type: "tool_start",
      call,
      ts: Date.now(),
    });

    const toolStart = Date.now();
    const decision = await fireBeforeTool(call, thread.messages);

    if (decision?.skip) {
      const r = wrapToolResult(call, {
        content: decision.result ?? "Tool skipped",
        isError: decision.isError ?? (decision.result ? true : undefined),
      });
      thread.messages.push({ role: "user", content: [r] } as Message);
      await save(thread.messages);
      return false;
    }

    let resultBlock: ToolResultBlock;
    try {
      const input = decision?.input ?? call.input;
      const tool = toolMap.get(call.name);
      if (!tool) {
        resultBlock = wrapToolResult(call, {
          content: `Tool not found: ${call.name}`,
          isError: true,
        });
      } else {
        const out = await tool.execute(input, opts.signal);
        resultBlock = wrapToolResult(call, out);
      }
    } catch (err) {
      if (err instanceof InterruptSignal) {
        await save(thread.messages);
        if (!checkpointer.saveInterrupt) {
          throw new Error(
            "Tool requested interrupt but checkpointer does not support it. " +
              "Use a checkpointer that implements saveInterrupt/consumeInterrupt.",
            { cause: err },
          );
        }
        await checkpointer.saveInterrupt(thread.id, {
          pendingTool: { call, reason: err.reason },
          ts: Date.now(),
          meta: err.meta,
        });
        await checkpointer.appendEvent?.(thread.id, {
          type: "interrupt",
          pendingTool: call,
          reason: err.reason,
          ts: Date.now(),
        });
        yield {
          type: "interrupted",
          payload: {
            pendingTool: call,
            reason: err.reason,
            meta: err.meta,
          },
        };
        return true;
      }
      resultBlock = wrapToolResult(call, {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      });
    }

    thread.messages.push({
      role: "user",
      content: [resultBlock],
    } as Message);
    await fireAfterTool(call, resultBlock, thread.messages);
    await checkpointer.appendEvent?.(thread.id, {
      type: "tool_end",
      result: resultBlock,
      durationMs: Date.now() - toolStart,
      ts: Date.now(),
    });
    await save(thread.messages);
    return false;
  }

  async function* runLoop(opts: {
    signal?: AbortSignal;
    maxSteps: number;
    stream?: boolean;
  }): AsyncGenerator<AgentEvent> {
    for (let step = 0; step < opts.maxSteps; step++) {
      if (opts.signal?.aborted) {
        await checkpointer.appendEvent?.(thread.id, {
          type: "run_end",
          reason: "aborted",
          ts: Date.now(),
        });
        return;
      }

      const cmCtx = {
        threadId: thread.id,
        signal: opts.signal,
        logger,
        model,
      };
      const shaped = await contextManager.shape(cmCtx, thread.messages);
      const finalMsgs = await fireBeforeModel(shaped);

      await checkpointer.appendEvent?.(thread.id, {
        type: "model_start",
        messageCount: finalMsgs.length,
        ts: Date.now(),
      });

      // Stream-aware model call: when opts.stream is true, yield text_delta
      // events for preview before assembling the full message.
      const modelStream = model.stream(finalMsgs, { signal: opts.signal, tools });
      let blocks: ContentBlock[];
      let usage: AIMessageChunk["usage"];

      if (opts.stream) {
        // Manual accumulation — yield text_delta for text chunks, then final message
        blocks = [];
        const partialJson = new Map<string, string>();
        let blockIndex = 0;
        for await (const chunk of modelStream) {
          // Increment blockIndex when a new text block starts (text after non-text)
          if (
            chunk.delta?.type === "text" &&
            blocks.length > 0 &&
            blocks[blocks.length - 1]?.type !== "text"
          ) {
            blockIndex++;
          }
          if (chunk.delta?.type === "text") {
            yield { type: "text_delta", payload: { blockIndex, text: chunk.delta.text } };
          }
          mergeChunkIntoBlocks(blocks, partialJson, chunk);
          if (chunk.stopReason !== undefined) { /* captured below for checkpointer event */ }
          if (chunk.usage !== undefined) usage = chunk.usage;
          if (chunk.done) break;
        }
        finalizeToolUseInputs(blocks, partialJson);
      } else {
        const collected = await collectStream(modelStream);
        const result = collected;
        blocks = result.blocks;
        usage = result.usage;
      }

      await checkpointer.appendEvent?.(thread.id, {
        type: "model_end",
        blocks: blocks.slice(),
        usage,
        ts: Date.now(),
      });

      if (blocks.length === 0) {
        await checkpointer.appendEvent?.(thread.id, {
          type: "run_end",
          reason: "complete",
          ts: Date.now(),
        });
        return;
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: blocks.slice(),
      };
      thread.messages.push(assistantMsg);
      await fireAfterModel(thread.messages);
      yield { type: "message", payload: assistantMsg };

      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        await save(thread.messages);
        await checkpointer.appendEvent?.(thread.id, {
          type: "run_end",
          reason: "complete",
          ts: Date.now(),
        });
        return;
      }

      for (let i = 0; i < toolUses.length; i++) {
        const call = toolUses[i]!;
        const interrupted = yield* executeOne(call, opts);
        if (interrupted) {
          // H1+R4: Add placeholder tool_results for ALL unexecuted tool_use blocks
          // (including the interrupting one — eliminates orphan window before resume)
          for (let j = i; j < toolUses.length; j++) {
            const remaining = toolUses[j]!;
            thread.messages.push({
              role: "user",
              content: [wrapToolResult(remaining, { content: "Interrupted", isError: true })],
            } as Message);
          }
          await save(thread.messages);
          return;
        }
      }
    }

    await checkpointer.appendEvent?.(thread.id, {
      type: "run_end",
      reason: "maxSteps",
      ts: Date.now(),
    });
  }

  return {
    thread,

    fork(msgs, id): Agent {
      const newId = id ?? crypto.randomUUID();
      if (id && id === thread.id) {
        throw new Error(
          "Cannot fork with the same threadId as the parent. Pass a new id or omit it.",
        );
      }
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        threadId: newId,
        checkpointer,
        _initialMessages: msgs ?? structuredClone(thread.messages),
      });
    },

    async *run(input: string, opts: AgentRunOptions = {}) {
      if (running) {
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      }
      running = true;
      ctx.signal = opts.signal;
      try {
        opts.signal?.throwIfAborted();

        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", content: systemPrompt });
        }
        thread.messages.push({ role: "user", content: input });
        await save(thread.messages);
        await checkpointer.appendEvent?.(thread.id, {
          type: "user_input",
          content: input,
          ts: Date.now(),
        });

        yield* runLoop({ signal: opts.signal, maxSteps: opts.maxSteps ?? 32, stream: opts.stream });
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },

    async *resume(command: ResumeCommand, opts: AgentRunOptions = {}) {
      if (running) {
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      }
      running = true;
      ctx.signal = opts.signal;
      try {
        const it = await checkpointer.consumeInterrupt?.(thread.id);
        if (!it) throw new Error("No pending interrupt for this thread");

        await checkpointer.appendEvent?.(thread.id, {
          type: "resume",
          ts: Date.now(),
        });

        // R4: Replace interrupt placeholder with real tool_result
        const placeholderIdx = thread.messages.findLastIndex((m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (b) => b.type === "tool_result" && b.tool_use_id === it.pendingTool.call.id && b.is_error === true,
          ),
        );
        const realResult = {
          type: "tool_result" as const,
          tool_use_id: it.pendingTool.call.id,
          content: command.message ?? (command.approved ? "approved" : "denied by user"),
          is_error: !command.approved,
        };
        if (placeholderIdx >= 0) {
          // Replace the placeholder message in-place
          thread.messages[placeholderIdx] = { role: "user", content: [realResult] } as Message;
        } else {
          thread.messages.push({ role: "user", content: [realResult] } as Message);
        }
        await save(thread.messages);

        yield* runLoop({ signal: opts.signal, maxSteps: opts.maxSteps ?? 32, stream: opts.stream });
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },
  };
}
