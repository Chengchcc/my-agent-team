import type {
  AIMessageChunk,
  ChatModel,
  ContentBlock,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from "@my-agent-team/core";
import { collectStream, finalizeToolUseInputs, mergeChunkIntoBlocks } from "@my-agent-team/core";
import { type Checkpointer, InterruptSignal, validateCheckpointer } from "./checkpointer.js";
import { inMemoryCheckpointer } from "./checkpointers/in-memory.js";
import type { ContextManager } from "./context-manager.js";
import { passthroughContextManager } from "./context-managers/passthrough.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { HookContext, Plugin, StopDecision } from "./plugin.js";
import { validatePlugins } from "./plugin.js";
import { createThread, type Thread } from "./thread.js";

export interface Interrupt {
  pendingTool?: ToolUseBlock;
  reason: string;
  meta?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "message"; payload: Message }
  | { type: "interrupted"; payload: Interrupt }
  | { type: "error"; payload: { message: string; stack?: string } }
  | { type: "text_delta"; payload: { blockIndex: number; text: string } }
  | { type: "reasoning_delta"; payload: { text: string } }
  | { type: "tool_start"; payload: { id: string; name: string } }
  | { type: "tool_end"; payload: { id: string; name: string; isError?: boolean } }
  | {
      type: "todo_update";
      payload: { todos: Array<{ step: string; status: "pending" | "in_progress" | "done" }> };
    }
  // ── M16.3: Persisted per-call metrics (not deltas) ──
  | {
      type: "llm_call";
      payload: {
        step: number;
        model: string;
        usage: { input: number; output: number; cacheCreate?: number; cacheRead?: number };
        latencyMs: number;
        ttftMs?: number;
        stopReason?: string;
      };
    }
  | {
      type: "tool_call";
      payload: {
        step: number;
        id: string;
        name: string;
        latencyMs: number;
        isError: boolean;
      };
    };

export interface ResumeCommand {
  approved: boolean;
  message?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
}

export interface Agent {
  readonly thread: Thread;
  run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Continue from existing checkpoint messages without appending a new user
   *  message. Use when the conversation context has already been written to the
   *  checkpointer (e.g. conversation-triggered runs where broadcastMessage()
   *  pre-projected the user's message). Fails if no user message exists. */
  continue(opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  resume(command: ResumeCommand, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
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

// ─── Pure helpers ──────────────────────────────────────────────

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

// ─── Plugin runner (extracted fire* helpers) ───────────────────

interface PluginRunner {
  fireBeforeModel(msgs: Message[]): Promise<Message[]>;
  fireAfterModel(msgs: readonly Message[]): Promise<void>;
  fireBeforeTool(
    call: ToolUseBlock,
    msgs: readonly Message[],
  ): Promise<{ skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined>;
  fireAfterTool(
    call: ToolUseBlock,
    result: ToolResultBlock,
    msgs: readonly Message[],
  ): Promise<void>;
  fireBeforeRun(msgs: readonly Message[]): Promise<readonly Message[]>;
  fireBeforeStop(msgs: readonly Message[]): Promise<StopDecision | undefined>;
}

function createPluginRunner(
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

// ─── Agent runtime (bundles shared state for extracted functions) ──

interface AgentRuntime {
  thread: Thread;
  plugins: PluginRunner;
  toolMap: Map<string, Tool>;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  logger: Logger;
  model: ChatModel;
  tools: readonly Tool[];
  pendingEvents: AgentEvent[];
  save: (msgs: Message[]) => Promise<void>;
}

// ─── executeOne (extracted from createAgentInternal) ────────────

async function* executeOne(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): AsyncGenerator<AgentEvent, boolean> {
  await rt.checkpointer.appendEvent?.(rt.thread.id, { type: "tool_start", call, ts: Date.now() });
  yield { type: "tool_start", payload: { id: call.id, name: call.name } };

  const toolStart = Date.now();
  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    rt.thread.messages.push({ role: "user", content: [r] } as Message);
    await rt.save(rt.thread.messages);
    yield {
      type: "tool_call",
      payload: { step, id: call.id, name: call.name, latencyMs: Date.now() - toolStart, isError: r.is_error === true },
    };
    yield {
      type: "tool_end",
      payload: { id: call.id, name: call.name, isError: r.is_error as boolean | undefined },
    };
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
      yield { type: "tool_call", payload: { step, id: call.id, name: call.name, latencyMs: Date.now() - toolStart, isError: true } };
      yield { type: "tool_end", payload: { id: call.id, name: call.name, isError: true } };
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

  rt.thread.messages.push({ role: "user", content: [resultBlock] } as Message);
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
    payload: { step, id: call.id, name: call.name, latencyMs: Date.now() - toolStart, isError: resultBlock.is_error === true },
  };
  yield {
    type: "tool_end",
    payload: { id: call.id, name: call.name, isError: resultBlock.is_error as boolean | undefined },
  };
  await rt.save(rt.thread.messages);
  return false;
}

// ─── runLoop (extracted from createAgentInternal) ───────────────

async function* runLoop(
  rt: AgentRuntime,
  opts: { signal?: AbortSignal; maxSteps: number; stream?: boolean; maxForceContinues?: number },
): AsyncGenerator<AgentEvent> {
  let forceContinues = 0;
  const maxForce = opts.maxForceContinues ?? 3;
  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) {
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
      let blockIndex = 0;
      for await (const chunk of modelStream) {
        if (
          chunk.delta?.type === "text" &&
          blocks.length > 0 &&
          blocks[blocks.length - 1]?.type !== "text"
        ) {
          blockIndex++;
        }
        if (chunk.delta?.type === "text") {
          if (ttftMs === undefined) ttftMs = Date.now() - llmStart;
          yield { type: "text_delta", payload: { blockIndex, text: chunk.delta.text } };
        }
        if (chunk.delta?.type === "reasoning") {
          yield { type: "reasoning_delta", payload: { text: chunk.delta.text } };
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
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "run_end",
        reason: "complete",
        ts: Date.now(),
      });
      return;
    }

    const assistantMsg: Message = { role: "assistant", content: blocks.slice() };
    rt.thread.messages.push(assistantMsg);
    await rt.plugins.fireAfterModel(rt.thread.messages);
    yield { type: "message", payload: assistantMsg };

    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (maxForce > 0 && forceContinues < maxForce) {
        const verdict = await rt.plugins.fireBeforeStop(rt.thread.messages);
        for (const ev of rt.pendingEvents.splice(0)) yield ev;
        if (verdict?.continue) {
          forceContinues++;
          rt.thread.messages.push({ role: "user", content: verdict.reason } as Message);
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
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "run_end",
        reason: "complete",
        ts: Date.now(),
      });
      return;
    }

    for (let i = 0; i < toolUses.length; i++) {
      const call = toolUses[i]!;
      const interrupted = yield* executeOne(rt, call, opts, step);
      if (interrupted) {
        for (let j = i; j < toolUses.length; j++) {
          const remaining = toolUses[j]!;
          rt.thread.messages.push({
            role: "user",
            content: [wrapToolResult(remaining, { content: "Interrupted", isError: true })],
          } as Message);
        }
        await rt.save(rt.thread.messages);
        return;
      }
    }
  }

  await rt.checkpointer.appendEvent?.(rt.thread.id, {
    type: "run_end",
    reason: "maxSteps",
    ts: Date.now(),
  });
}

// ─── createAgent / createAgentInternal ──────────────────────────

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

  const pendingEvents: AgentEvent[] = [];
  const ctx: HookContext = {
    threadId: thread.id,
    signal: undefined,
    logger,
    checkpointer,
    contextManager,
    emit: (event: AgentEvent) => {
      pendingEvents.push(event);
    },
  };

  const pluginRunner = createPluginRunner(plugins, ctx, logger);

  const rt: AgentRuntime = {
    thread,
    plugins: pluginRunner,
    toolMap,
    checkpointer,
    contextManager,
    logger,
    model,
    tools,
    pendingEvents,
    save,
  };

  function runLoopOpts(opts: AgentRunOptions) {
    return {
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? 32,
      stream: opts.stream,
      maxForceContinues: opts.maxForceContinues,
    };
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
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
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

        const seeded = await pluginRunner.fireBeforeRun(thread.messages);
        if (seeded !== thread.messages) {
          thread.messages.length = 0;
          thread.messages.push(...seeded);
          await save(thread.messages);
        }
        for (const ev of pendingEvents.splice(0)) yield ev;
        yield* runLoop(rt, runLoopOpts(opts));
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },

    async *continue(opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      if (!thread.messages.some((m) => m.role === "user")) {
        throw new Error(
          "Cannot continue without a user message in checkpoint. Use run() for fresh input.",
        );
      }
      running = true;
      ctx.signal = opts.signal;
      try {
        opts.signal?.throwIfAborted();
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", content: systemPrompt });
          await save(thread.messages);
        }

        const seeded = await pluginRunner.fireBeforeRun(thread.messages);
        if (seeded !== thread.messages) {
          thread.messages.length = 0;
          thread.messages.push(...seeded);
          await save(thread.messages);
        }
        for (const ev of pendingEvents.splice(0)) yield ev;
        yield* runLoop(rt, runLoopOpts(opts));
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },

    async *resume(command: ResumeCommand, opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
      try {
        const it = await checkpointer.consumeInterrupt?.(thread.id);
        if (!it) throw new Error("No pending interrupt for this thread");

        await checkpointer.appendEvent?.(thread.id, { type: "resume", ts: Date.now() });

        const placeholderIdx = thread.messages.findLastIndex(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some(
              (b) =>
                b.type === "tool_result" &&
                b.tool_use_id === it.pendingTool.call.id &&
                b.is_error === true,
            ),
        );
        const realResult = {
          type: "tool_result" as const,
          tool_use_id: it.pendingTool.call.id,
          content: command.message ?? (command.approved ? "approved" : "denied by user"),
          is_error: !command.approved,
        };
        if (placeholderIdx >= 0) {
          thread.messages[placeholderIdx] = { role: "user", content: [realResult] } as Message;
        } else {
          thread.messages.push({ role: "user", content: [realResult] } as Message);
        }
        await save(thread.messages);
        yield* runLoop(rt, runLoopOpts(opts));
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },
  };
}
