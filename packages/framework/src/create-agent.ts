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
import { createPluginRunner } from "./plugin-runner.js";
import { runLoop } from "./run-loop.js";
import { createThread } from "./thread.js";

// ─── Public exports (thin re-exports from extracted modules) ──

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

// ─── createAgent / createAgentInternal ──────────────────────────

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const threadId = config.threadId ?? crypto.randomUUID();
  const checkpointer = config.checkpointer ?? inMemoryCheckpointer();
  validateCheckpointer(checkpointer);

  let messages: Message[];
  if (config.messages) {
    messages = config.messages;
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

  const subscribers = new Set<AgentEventListener>();

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
    runId: thread.id,
    toolStates: [],
    assistantBlocks: [],
    subscribers,
  };

  function runLoopOpts(opts: AgentRunOptions) {
    return {
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? 32,
      stream: opts.stream,
      maxForceContinues: opts.maxForceContinues,
    };
  }

  /** Wraps a runLoop generator to notify subscribers on each yielded event. */
  async function* withSubscribers(gen: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of gen) {
      yield event;
      for (const sub of subscribers) sub(event);
    }
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

    subscribe(listener: AgentEventListener): () => void {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    async *run(input: string, opts: AgentRunOptions = {}) {
      if (running)
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      running = true;
      ctx.signal = opts.signal;
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
        yield* withSubscribers(runLoop(rt, runLoopOpts(opts)));
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
        yield* withSubscribers(runLoop(rt, runLoopOpts(opts)));
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
        yield* withSubscribers(runLoop(rt, runLoopOpts(opts)));
      } finally {
        running = false;
        ctx.signal = undefined;
      }
    },
  };
}
