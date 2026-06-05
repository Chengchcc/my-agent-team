import type { ChatModel, ContentBlock, Message, Tool } from "@my-agent-team/core";
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

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const threadId = config.threadId ?? crypto.randomUUID();
  let messages: Message[] = [];

  if (config.checkpointer) {
    const loaded = await config.checkpointer.load(threadId);
    if (loaded) messages = loaded;
  }

  const thread = createThread(messages, threadId);
  const tools = config.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const plugins = [...(config.plugins ?? [])];

  return {
    thread,
    fork(msgs, id): Agent {
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        threadId: id ?? crypto.randomUUID(),
        tools,
        _initialMessages: msgs ?? [],
      });
    },
    async *run(input, opts = {}) {
      const maxSteps = opts.maxSteps ?? 32;
      opts.signal?.throwIfAborted();
      if (config.systemPrompt && !thread.messages.some((m) => m.role === "system")) {
        thread.messages.unshift({ role: "system", content: config.systemPrompt });
      }
      thread.messages.push({ role: "user", content: input });

      const ctx: HookContext = { threadId: thread.id, signal: opts.signal };

      for (let step = 0; step < maxSteps; step++) {
        if (opts.signal?.aborted) return;
        // beforeModel
        let workingMessages = thread.messages.slice();
        for (const p of plugins) {
          if (p.hooks.beforeModel) {
            const result = await p.hooks.beforeModel(ctx, workingMessages);
            workingMessages = result ?? workingMessages;
          }
        }

        // collect model stream
        const collected = await collectStream(config.model.stream(workingMessages));
        const { blocks } = collected;

        if (blocks.length === 0) return;

        // finalize tools
        const assistantMsg: Message = { role: "assistant", content: blocks.slice() };
        thread.messages.push(assistantMsg);
        yield assistantMsg;

        // afterModel
        for (const p of plugins) {
          if (p.hooks.afterModel) {
            try { await p.hooks.afterModel(ctx, thread.messages.slice()); } catch { /* swallowed */ }
          }
        }

        const toolUses = blocks.filter(
          (b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use",
        );
        if (toolUses.length === 0) {
          await config.checkpointer?.save(thread.id, thread.messages.slice());
          return;
        }

        const results: ContentBlock[] = [];
        for (const call of toolUses) {
          // beforeTool
          let toolInput: unknown = call.input;
          let skip = false;
          let skipResult: string | undefined;

          for (const p of plugins) {
            if (p.hooks.beforeTool) {
              const decision = await p.hooks.beforeTool(ctx, call, thread.messages);
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

        const userMsg: Message = { role: "user", content: results };
        thread.messages.push(userMsg);
        yield userMsg;

        // afterTool
        for (let i = 0; i < toolUses.length; i++) {
          for (const p of plugins) {
            if (p.hooks.afterTool) {
              try {
                await p.hooks.afterTool(ctx, toolUses[i]!, results[i]!, thread.messages.slice());
              } catch { /* swallowed */ }
            }
          }
        }

        await config.checkpointer?.save(thread.id, thread.messages.slice());
      }
    },
  };
}

function createAgentInternal(config: AgentConfig & { _initialMessages: Message[] }): Agent {
  const thread = createThread(config._initialMessages, config.threadId);
  const tools = config.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const plugins = [...(config.plugins ?? [])];
  const systemPrompt = config.systemPrompt;

  return {
    thread,
    fork(msgs, id): Agent {
      return createAgentInternal({
        ...config,
        plugins: [...plugins],
        threadId: id ?? crypto.randomUUID(),
        tools,
        _initialMessages: msgs ?? [],
      });
    },
    async *run(input) {
      if (systemPrompt && !thread.messages.some((m) => m.role === "system")) {
        thread.messages.unshift({ role: "system", content: systemPrompt });
      }
      thread.messages.push({ role: "user", content: input });
      const ctx: HookContext = { threadId: thread.id };

      for (let step = 0; step < 32; step++) {
        let workingMessages = thread.messages.slice();
        for (const p of plugins) {
          if (p.hooks.beforeModel) {
            const result = await p.hooks.beforeModel(ctx, workingMessages);
            workingMessages = result ?? workingMessages;
          }
        }
        const collected = await collectStream(config.model.stream(workingMessages));
        const { blocks } = collected;
        if (blocks.length === 0) return;
        const assistantMsg: Message = { role: "assistant", content: blocks.slice() };
        thread.messages.push(assistantMsg);
        yield assistantMsg;
        for (const p of plugins) {
          if (p.hooks.afterModel) {
            try { await p.hooks.afterModel(ctx, thread.messages.slice()); } catch { /* swallowed */ }
          }
        }
        const toolUses = blocks.filter(
          (b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use",
        );
        if (toolUses.length === 0) {
          await config.checkpointer?.save(thread.id, thread.messages.slice());
          return;
        }
        const results: ContentBlock[] = [];
        for (const call of toolUses) {
          let toolInput: unknown = call.input;
          let skip = false;
          let skipResult: string | undefined;
          for (const p of plugins) {
            if (p.hooks.beforeTool) {
              const decision = await p.hooks.beforeTool(ctx, call, thread.messages);
              if (decision) {
                if (decision.skip) { skip = true; if (decision.result) skipResult = decision.result; }
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
            results.push({ type: "tool_result", tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true });
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
            results.push({ type: "tool_result", tool_use_id: call.id, content: err instanceof Error ? err.message : String(err), is_error: true });
          }
        }
        const userMsg: Message = { role: "user", content: results };
        thread.messages.push(userMsg);
        yield userMsg;
        for (let i = 0; i < toolUses.length; i++) {
          for (const p of plugins) {
            if (p.hooks.afterTool) {
              try { await p.hooks.afterTool(ctx, toolUses[i]!, results[i]!, thread.messages.slice()); } catch { /* swallowed */ }
            }
          }
        }
        await config.checkpointer?.save(thread.id, thread.messages.slice());
      }
    },
  };
}
