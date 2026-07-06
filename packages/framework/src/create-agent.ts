import type { Message } from "@my-agent-team/message";
import type { AgentEvent } from "./agent-event.js";
import type {
  Agent,
  AgentConfig,
  AgentEventListener,
  AgentRunOptions,
  AgentRuntime,
  ResumeCommand,
} from "./agent-options.js";
import { type Checkpointer, validateCheckpointer } from "./checkpointer.js";
import { inMemoryCheckpointer } from "./checkpointers/in-memory.js";
import { passthroughContextManager } from "./context-managers/passthrough.js";
import { consoleLogger } from "./logger.js";
import type { HookContext } from "./plugin.js";
import { validatePlugins } from "./plugin.js";
import { createPluginRunner } from "./plugin-dispatcher.js";
import { spanLoop } from "./span-loop.js";
import { createThread } from "./thread.js";

export type { AgentEvent, Interrupt } from "./agent-event.js";
export { parseAgentEvent, safeParseAgentEvent } from "./agent-event.js";
export type {
  Agent,
  AgentConfig,
  AgentEventListener,
  AgentRunOptions,
  FollowUpQueue,
  ResumeCommand,
  SteeringQueue,
} from "./agent-options.js";

export async function createAgent<Ctx = Record<string, unknown>>(
  config: AgentConfig<Ctx>,
): Promise<Agent<Ctx>> {
  const sessionId = config.sessionId ?? crypto.randomUUID();
  const checkpointer = config.checkpointer ?? inMemoryCheckpointer();
  validateCheckpointer(checkpointer);

  let messages: Message[];
  if (config.messages) {
    messages = config.messages;
    checkpointer.save(sessionId, messages).catch(() => {});
  } else {
    const loaded = await checkpointer.load(sessionId);
    messages = loaded ?? [];
  }

  return createAgentInternal({
    ...config,
    checkpointer,
    sessionId,
    _initialMessages: messages,
  });
}

function createAgentInternal<Ctx = Record<string, unknown>>(
  config: AgentConfig<Ctx> & {
    _initialMessages: Message[];
    sessionId: string;
    checkpointer: Checkpointer;
  },
): Agent<Ctx> {
  const thread = createThread(config._initialMessages, config.sessionId);
  const plugins = [...(config.plugins ?? [])];
  const tools = validatePlugins<Ctx>(plugins, config.tools);
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
  const ctx: HookContext<Ctx> = {
    sessionId: thread.id,
    signal: undefined,
    logger,
    checkpointer,
    contextManager,
    emit: (event: AgentEvent) => {
      pendingEvents.push(event);
    },
    data: undefined,
  };

  const pluginRunner = createPluginRunner<Ctx>(plugins, ctx, logger);

  const subscribers = new Set<AgentEventListener>();

  const rt: AgentRuntime<Ctx> = {
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
    spanId: thread.id,
    toolStates: [],
    assistantBlocks: [],
    subscribers,
  };

  function spanLoopOpts(opts: AgentRunOptions<Ctx>) {
    return {
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? 32,
      stream: opts.stream,
      maxForceContinues: opts.maxForceContinues,
      steering: opts.steering,
      followUp: opts.followUp,
    };
  }

  async function* withSubscribers(gen: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of gen) {
      yield event;
      for (const sub of subscribers) sub(event);
    }
  }

  return {
    thread,

    fork(msgs, id): Agent<Ctx> {
      const newId = id ?? crypto.randomUUID();
      if (id && id === thread.id) {
        throw new Error(
          "Cannot fork with the same sessionId as the parent. Pass a new id or omit it.",
        );
      }
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        sessionId: newId,
        checkpointer,
        _initialMessages: msgs ?? structuredClone(thread.messages),
      });
    },

    subscribe(listener: AgentEventListener): () => void {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    async *run(input: string, opts: AgentRunOptions<Ctx> = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.data = opts.data;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        yield { type: "agent_start" as const, spanId: rt.spanId };
        opts.signal?.throwIfAborted();
        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", text: systemPrompt });
        }
        if (input.trim()) {
          thread.messages.push({ role: "user", text: input });
          await save(thread.messages);
          await checkpointer.appendEvent?.(thread.id, rt.spanId, {
            type: "user_input",
            content: input,
            ts: Date.now(),
          });
        }

        const seeded = await pluginRunner.fireBeforeRun(thread.messages);
        if (seeded !== thread.messages) {
          thread.messages.length = 0;
          thread.messages.push(...seeded);
          await save(thread.messages);
        }
        for (const ev of pendingEvents.splice(0)) yield ev;
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.data = undefined;
        running = false;
        ctx.signal = undefined;
      }
    },

    async *continue(opts: AgentRunOptions<Ctx> = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      if (!thread.messages.some((m) => m.role === "user")) {
        throw new Error(
          "Cannot continue without a user message in checkpoint. Use run() for fresh input.",
        );
      }
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.data = opts.data;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        yield { type: "agent_start" as const, spanId: rt.spanId };
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
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.data = undefined;
        running = false;
        ctx.signal = undefined;
      }
    },

    async *resume(command: ResumeCommand, opts: AgentRunOptions<Ctx> = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
      rt.spanId = opts.spanId ?? crypto.randomUUID();
      ctx.span = await config.startSpan?.(rt.spanId, thread.id, opts.origin);
      ctx.data = opts.data;
      rt.toolStates = [];
      rt.assistantBlocks = [];
      let runStatus: "succeeded" | "error" | "interrupted" = "succeeded";
      let lastError: string | undefined;
      try {
        yield { type: "agent_start" as const, spanId: rt.spanId };
        const it = await checkpointer.consumeInterrupt?.(thread.id);
        if (!it) throw new Error("No pending interrupt for this thread");

        await checkpointer.appendEvent?.(thread.id, rt.spanId, {
          type: "resume",
          ts: Date.now(),
        });

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
        yield* withSubscribers(spanLoop(rt, spanLoopOpts(opts)));
      } catch (err) {
        runStatus = opts.signal?.aborted ? "interrupted" : "error";
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        ctx.span?.end(runStatus, lastError);
        yield { type: "agent_end" as const, spanId: rt.spanId, status: runStatus };
        ctx.span = undefined;
        ctx.data = undefined;
        running = false;
        ctx.signal = undefined;
      }
    },
  };
}
