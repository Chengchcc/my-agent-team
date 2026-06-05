import type {
  ChatModel,
  ContentBlock,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import type { Checkpointer } from "./checkpointer.js";
import type { HookContext, Plugin } from "./plugin.js";
import { createThread, type Thread } from "./thread.js";

export interface Agent {
  readonly thread: Thread;
  run(input: string, opts?: { signal?: AbortSignal; maxSteps?: number }): AsyncIterable<Message>;
  fork(messages?: Message[], id?: string): Agent;
}

export interface AgentConfig {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin[];
  checkpointer?: Checkpointer;
  threadId?: string;
}

function warn(context: string, error: unknown): void {
  console.warn(`[framework] ${context}:`, error);
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const threadId = config.threadId ?? crypto.randomUUID();
  let messages: Message[] = [];

  if (config.checkpointer) {
    const loaded = await config.checkpointer.load(threadId);
    if (loaded) messages = loaded;
  }

  return createAgentInternal({ ...config, threadId, _initialMessages: messages });
}

function createAgentInternal(
  config: AgentConfig & { _initialMessages: Message[]; threadId: string },
): Agent {
  const thread = createThread(config._initialMessages, config.threadId);
  const tools = config.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const plugins = [...(config.plugins ?? [])];
  const systemPrompt = config.systemPrompt;
  let running = false;

  const save = async (msgs: Message[]) => {
    if (!config.checkpointer) return;
    try {
      await config.checkpointer.save(thread.id, msgs);
    } catch (err) {
      warn(`checkpointer.save ${thread.id}`, err);
    }
  };

  return {
    thread,
    fork(msgs, id): Agent {
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        threadId: id ?? crypto.randomUUID(),
        tools,
        _initialMessages: msgs ?? structuredClone(thread.messages),
      });
    },
    async *run(input, opts = {}) {
      if (running) {
        throw new Error("Agent is already running. Use fork() for concurrent conversations.");
      }
      running = true;
      try {
        const maxSteps = opts.maxSteps ?? 32;
        opts.signal?.throwIfAborted();

        if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
          thread.messages.unshift({ role: "system", content: systemPrompt });
        }
        thread.messages.push({ role: "user", content: input });

        const ctx: HookContext = { threadId: thread.id, signal: opts.signal };

        for (let step = 0; step < maxSteps; step++) {
          if (opts.signal?.aborted) {
            running = false;
            return;
          }

          let workingMessages = thread.messages.slice();
          for (const p of plugins) {
            if (p.hooks.beforeModel) {
              try {
                const result = await p.hooks.beforeModel(ctx, workingMessages);
                workingMessages = result ?? workingMessages;
              } catch (err) {
                running = false;
                throw err;
              }
            }
          }

          const collected = await collectStream(config.model.stream(workingMessages));
          const { blocks } = collected;

          if (blocks.length === 0) {
            await save(thread.messages.slice());
            running = false;
            return;
          }

          const assistantMsg: Message = { role: "assistant", content: blocks.slice() };
          thread.messages.push(assistantMsg);
          yield assistantMsg;

          for (const p of plugins) {
            if (p.hooks.afterModel) {
              try {
                await p.hooks.afterModel(ctx, thread.messages.slice());
              } catch (err) {
                warn(`afterModel ${p.name}`, err);
              }
            }
          }

          const toolUses = blocks.filter(
            (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
              b.type === "tool_use",
          );
          if (toolUses.length === 0) {
            await save(thread.messages.slice());
            running = false;
            return;
          }

          const results = await executeTools(toolUses, toolMap, plugins, ctx, thread.messages);

          if (opts.signal?.aborted) {
            running = false;
            return;
          }

          const userMsg: Message = { role: "user", content: results };
          thread.messages.push(userMsg);
          yield userMsg;

          for (let i = 0; i < toolUses.length; i++) {
            for (const p of plugins) {
              if (p.hooks.afterTool) {
                const call = toolUses[i] as ToolUseBlock | undefined;
                const result = results[i] as ToolResultBlock | undefined;
                if (call && result) {
                  try {
                    await p.hooks.afterTool(ctx, call, result, thread.messages.slice());
                  } catch (err) {
                    warn(`afterTool ${p.name}`, err);
                  }
                }
              }
            }
          }

          await save(thread.messages.slice());
        }
      } finally {
        running = false;
      }
    },
  };
}

async function executeTools(
  toolUses: { type: "tool_use"; id: string; name: string; input: unknown }[],
  toolMap: Map<string, Tool>,
  plugins: readonly Plugin[],
  ctx: HookContext,
  messages: readonly Message[],
): Promise<ContentBlock[]> {
  const results: ContentBlock[] = [];
  for (const call of toolUses) {
    let toolInput: unknown = call.input;
    let skip = false;
    let skipResult: string | undefined;

    for (const p of plugins) {
      if (p.hooks.beforeTool) {
        const decision = await p.hooks.beforeTool(ctx, call, messages);
        if (decision) {
          if (decision.skip) {
            skip = true;
            if (decision.result) skipResult = decision.result;
          }
          if (decision.input !== undefined) toolInput = decision.input;
        }
      }
    }

    if (skip) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: skipResult ?? "Tool skipped",
        ...(skipResult ? { is_error: true } : {}),
      });
      continue;
    }

    const tool = toolMap.get(call.name);
    if (!tool) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: `Tool not found: ${call.name}`,
        is_error: true,
      });
      continue;
    }

    try {
      const out = await tool.execute(toolInput);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: out.content,
        ...(out.isError !== undefined ? { is_error: out.isError } : {}),
      });
    } catch (err) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    }
  }
  return results;
}
