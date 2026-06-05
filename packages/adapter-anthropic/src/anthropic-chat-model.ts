import { Anthropic } from "@anthropic-ai/sdk";
import type { AIMessageChunk, ChatModel, ChatModelOptions, Message } from "@my-agent-team/core";
import { toAnthropicTools } from "./to-anthropic-tools.js";

export interface AnthropicChatModelConfig {
  model?: string;
  thinking?: { type: "adaptive" };
  effort?: "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
}

export class AnthropicChatModel implements ChatModel {
  readonly id: string;
  readonly #client: Anthropic;
  readonly #config: AnthropicChatModelConfig;

  constructor(config: AnthropicChatModelConfig = {}) {
    this.#config = config;
    this.id = config.model ?? "claude-opus-4-7";
    this.#client = new Anthropic({
      apiKey: config.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: config.baseUrl,
    });
  }

  async *stream(
    messages: readonly Message[],
    options?: ChatModelOptions,
  ): AsyncIterable<AIMessageChunk> {
    const systemMessages = messages.filter((msg) => msg.role === "system");
    const systemBlock = systemMessages.at(-1);
    const system: string | undefined =
      typeof systemBlock?.content === "string" ? systemBlock.content : undefined;

    const apiMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;

      if (typeof msg.content === "string") {
        apiMessages.push({ role: msg.role, content: msg.content });
      } else {
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          } else if (block.type === "tool_result") {
            const tr: Record<string, unknown> = {
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
            };
            if (block.is_error !== undefined) {
              tr["is_error"] = block.is_error;
            }
            blocks.push(tr);
          }
        }
        apiMessages.push({ role: msg.role as "user" | "assistant", content: blocks });
      }
    }

    const params = {
      model: this.#config.model ?? "claude-opus-4-7",
      max_tokens: this.#config.maxTokens ?? 16000,
      messages: apiMessages,
      ...(system ? { system } : {}),
      ...(options?.tools ? { tools: toAnthropicTools(options.tools) } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = this.#client.messages.stream(params as any, {
      signal: options?.signal,
    });

    const blockIds = new Map<number, string>();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          yield { delta: { type: "text", text: event.content_block.text } };
        } else if (event.content_block.type === "tool_use") {
          blockIds.set(event.index, event.content_block.id);
          yield {
            delta: {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
            },
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { delta: { type: "text", text: event.delta.text } };
        } else if (event.delta.type === "input_json_delta") {
          const id = blockIds.get(event.index) ?? "";
          yield {
            delta: {
              type: "input_json_delta",
              id,
              partial_json: event.delta.partial_json,
            },
          };
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      done: true,
      stopReason: finalMessage?.stop_reason as AIMessageChunk["stopReason"],
      usage: finalMessage
        ? { input: finalMessage.usage.input_tokens, output: finalMessage.usage.output_tokens }
        : undefined,
    };
  }
}
