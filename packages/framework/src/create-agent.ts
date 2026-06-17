import type {
  AIMessageChunk,
  ChatModel,
  ContentBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from "@my-agent-team/core";
import { collectStream, finalizeToolUseInputs, mergeChunkIntoBlocks } from "@my-agent-team/core";
import type { Message, MessageRevision, MessageState } from "@my-agent-team/message";
import { assistantMessageId } from "@my-agent-team/message";
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

// ─── M17.3: AgentEvent codec — zod schema is the single source of truth ──

import { z } from "zod";

const interruptSchema = z.object({
  pendingTool: z
    .object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })
    .optional(),
  reason: z.string(),
  meta: z.record(z.unknown()).optional(),
});

const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), payload: z.unknown() }),
  z.object({
    type: z.literal("llm_call"),
    payload: z.object({
      step: z.number(),
      model: z.string(),
      usage: z.object({ input: z.number(), output: z.number(), cacheCreate: z.number().optional(), cacheRead: z.number().optional() }),
      latencyMs: z.number(),
      ttftMs: z.number().optional(),
      stopReason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool_call"),
    payload: z.object({ step: z.number(), id: z.string(), name: z.string(), latencyMs: z.number(), isError: z.boolean() }),
  }),
  z.object({ type: z.literal("interrupted"), payload: interruptSchema }),
  z.object({
    type: z.literal("todo_update"),
    payload: z.object({ todos: z.array(z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "done"]) })) }),
  }),
]);

// M17.3: AgentEvent derived from zod schema — schema is the single source of truth.
// Previously this was a hand-written TS union that could drift from the schema.
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Parse an AgentEvent from wire/persistence, throwing on invalid shape. */
export function parseAgentEvent(raw: unknown): AgentEvent {
  return agentEventSchema.parse(raw) as AgentEvent;
}

/** Safe-parse an AgentEvent (returns success/error instead of throwing). */
export function safeParseAgentEvent(raw: unknown): z.SafeParseReturnType<unknown, AgentEvent> {
  return agentEventSchema.safeParse(raw) as z.SafeParseReturnType<unknown, AgentEvent>;
}

export interface ResumeCommand {
  approved: boolean;
  message?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  /** M17.2: The run's identity, assigned by the runner/backend. Injected so
   *  framework can emit MessageRevision with the correct messageId. Falls
   *  back to thread.id when not provided (standalone mode). */
  runId?: string;
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
  /** Preloaded messages to bootstrap the thread. When provided, bypasses
   *  checkpointer.load() for the initial message state. The checkpointer
   *  is still used for subsequent saves during the run. */
  messages?: Message[];
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
  /** M17.2: The run's identity — set at run/continue/resume start. */
  runId: string;
  /** M17.2: Accumulated tool states for the current assistant message.
   *  Updated in-place by executeOne; read when emitting message revisions. */
  toolStates: import("@my-agent-team/message").MessageToolState[];
  /** M17.2 fix: Run-level accumulated assistant blocks — all emit revisions use
   *  the full accumulated set so consumer mergeMessageRevision shows complete history.
   *  Per-step blocks are still pushed to thread.messages for LLM context. */
  assistantBlocks: ContentBlock[];
}

// ─── executeOne (extracted from createAgentInternal) ────────────

async function* executeOne(
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
    const ts = rt.toolStates.find((t) => t.id === call.id);
    if (ts) {
      ts.state = r.is_error === true ? "error" : "done";
      ts.isError = r.is_error === true;
    }
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
      const ts = rt.toolStates.find((t) => t.id === call.id);
      if (ts) {
        ts.state = "error";
        ts.isError = true;
      }
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
  const ts = rt.toolStates.find((t) => t.id === call.id);
  if (ts) {
    ts.state = resultBlock.is_error === true ? "error" : "done";
    ts.isError = resultBlock.is_error === true;
  }
  await rt.save(rt.thread.messages);
  return false;
}

// ─── Pure helper: build an assistant MessageRevision ───────────

function buildAssistantRevision(
  runId: string,
  state: MessageState,
  blocks: ContentBlock[],
  tools: import("@my-agent-team/message").MessageToolState[],
): MessageRevision {
  return {
    messageId: assistantMessageId(runId),
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
function extractToolStates(
  blocks: ContentBlock[],
): import("@my-agent-team/message").MessageToolState[] {
  return blocks
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, state: "running" as const }));
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
      // M17.2 fix: mark remaining running tools as error, emit with accumulated blocks
      for (const ts of rt.toolStates) {
        if (ts.state === "running") {
          ts.state = "error";
          ts.isError = true;
        }
      }
      yield {
        type: "message",
        payload: {
          ...buildAssistantRevision(rt.runId, "error", rt.assistantBlocks, rt.toolStates),
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
        // M17.2: text_delta/reasoning_delta no longer top-level events — streaming
        // visibility is provided by per-step message revisions (state="streaming").
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
      // M17.2: emit terminal done before returning (with accumulated blocks)
      yield {
        type: "message",
        payload: buildAssistantRevision(rt.runId, "done", rt.assistantBlocks, rt.toolStates),
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

    // M17.2 fix: Accumulate blocks for full-run visibility. Consumer mergeMessageRevision
    // uses revision.blocks ?? base.blocks, which replaces the full array — so each
    // emit must carry ALL blocks from ALL steps, not just the current step.
    rt.assistantBlocks.push(...blocks);

    // M17.2: Extract tool states from model output — new tools are "running"
    const newTools = extractToolStates(blocks);
    // Merge with existing tool states: keep previous tools' states, add new ones
    for (const nt of newTools) {
      const existing = rt.toolStates.findIndex((t) => t.id === nt.id);
      if (existing >= 0) rt.toolStates[existing] = nt;
      else rt.toolStates.push(nt);
    }

    // Emit message revision (state=streaming) — uses FULL accumulated blocks
    yield {
      type: "message",
      payload: buildAssistantRevision(rt.runId, "streaming", rt.assistantBlocks, rt.toolStates),
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
      // M17.2: emit terminal done (with accumulated blocks)
      yield {
        type: "message",
        payload: buildAssistantRevision(rt.runId, "done", rt.assistantBlocks, rt.toolStates),
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
          // Mark remaining tools as error
          const ts = rt.toolStates.find((t) => t.id === remaining.id);
          if (ts) {
            ts.state = "error";
            ts.isError = true;
          }
        }
        // Emit message with updated tool states (shows which tools errored)
        yield {
          type: "message",
          payload: buildAssistantRevision(rt.runId, "waiting", rt.assistantBlocks, rt.toolStates),
        };
        await rt.save(rt.thread.messages);
        return;
      }
    }

    // After all tools in this step completed, emit updated revision with accumulated blocks + tool states
    yield {
      type: "message",
      payload: buildAssistantRevision(rt.runId, "streaming", rt.assistantBlocks, rt.toolStates),
    };
  }

  // M17.2 fix: maxSteps reached — mark remaining running tools as error, emit with accumulated blocks
  for (const ts of rt.toolStates) {
    if (ts.state === "running") {
      ts.state = "error";
      ts.isError = true;
    }
  }
  yield {
    type: "message",
    payload: {
      ...buildAssistantRevision(rt.runId, "error", rt.assistantBlocks, rt.toolStates),
      error: { message: "Max steps reached" },
    },
  };
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

  let messages: Message[];
  if (config.messages) {
    messages = config.messages;
    // Seed the checkpointer so crash recovery works (fire-and-forget).
    checkpointer.save(threadId, messages).catch(() => {});
  } else {
    const loaded = await checkpointer.load(threadId);
    messages = loaded ?? [];
  }

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
    runId: thread.id,     // M17.2: default to thread.id, overridden per-run
    toolStates: [],       // M17.2: reset each run
    assistantBlocks: [],  // M17.2: accumulated assistant blocks per run
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
      // M17.2: set run identity for this execution
      rt.runId = opts.runId ?? thread.id;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      try {
        opts.signal?.throwIfAborted();
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", text: systemPrompt });
        }
        thread.messages.push({ role: "user", text: input });
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
      // M17.2: set run identity for this execution
      rt.runId = opts.runId ?? thread.id;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      try {
        opts.signal?.throwIfAborted();
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", text: systemPrompt });
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
      // M17.2: set run identity for this execution
      rt.runId = opts.runId ?? thread.id;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      try {
        const it = await checkpointer.consumeInterrupt?.(thread.id);
        if (!it) throw new Error("No pending interrupt for this thread");

        await checkpointer.appendEvent?.(thread.id, { type: "resume", ts: Date.now() });

        const placeholderIdx = thread.messages.findLastIndex(
          (m) =>
            Array.isArray(m.blocks) &&
            m.blocks.some(
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
          thread.messages[placeholderIdx] = { role: "user", blocks: [realResult] };
        } else {
          thread.messages.push({ role: "user", blocks: [realResult] });
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
